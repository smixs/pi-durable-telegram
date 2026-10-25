import { open, realpath, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
	defineTool,
	type ToolExecutionApi,
	type ToolExecutionResult,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { probeImage } from "../agent/tools/image-probe.ts";
import { ChatInfo } from "../channel/docs.ts";
import { truncate } from "../format/escape.ts";
import type { Logger } from "../runtime/log.ts";
import { classifyTelegramError, telegramErrorSummary } from "./errors.ts";
import type { TelegramPort } from "./port.ts";

export const UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024;
const PHOTO_LIMIT_BYTES = 10 * 1024 * 1024;
const CAPTION_LIMIT = 1024;

type SendFileDeps = { readonly port: () => TelegramPort; readonly log: Logger; readonly uploadLimit?: number };

const parameters = Type.Object({
	path: Type.String({ description: "File path, absolute or relative to the working directory" }),
	caption: Type.Optional(Type.String({ description: "Optional caption, plain text, up to 1024 characters" })),
});

/** `telegram_send_file`: send a workspace file to the conversation's Telegram chat, as a photo when it is one. */
export function createSendFileTool(deps: SendFileDeps): ToolRegistration {
	const tool = defineTool({
		name: "telegram_send_file",
		description:
			"Send a file from the workspace to the user in Telegram. Images are sent as photos, everything else as documents. Limit 50 MB.",
		parameters,
		replay: "unsafe",
		execute: (args, api, context) => sendFile(args, api, context, deps),
	});
	return tool as unknown as ToolRegistration;
}

function failure(text: string): ToolExecutionResult {
	return { output: [{ type: "text", text }], isError: true };
}

async function sendFile(
	args: { path: string; caption?: string },
	api: ToolExecutionApi,
	context: Context,
	deps: SendFileDeps,
): Promise<ToolExecutionResult> {
	const chat = await api.snapshot(ChatInfo, api.conversationId, context);
	if (chat === undefined || chat.chatId === 0) return failure("No Telegram chat is bound to this conversation.");
	const located = await locate(args.path, (await api.agent(context)).cwd);
	if (typeof located === "string") return failure(located);
	const limit = deps.uploadLimit ?? UPLOAD_LIMIT_BYTES;
	if (located.size > limit) {
		return failure(
			`File is ${mb(located.size)} MB; Telegram bots can send at most ${mb(limit)} MB. Compress or split it.`,
		);
	}
	const caption = args.caption === undefined ? undefined : truncate(args.caption, CAPTION_LIMIT);
	const asPhoto = await isSendablePhoto(located.path, located.size);
	return upload(
		{ chatId: chat.chatId, threadId: chat.threadId, path: located.path, size: located.size, caption, asPhoto },
		deps,
		context,
	);
}

type Located = { path: string; size: number };

async function locate(path: string, cwd: string | undefined): Promise<Located | string> {
	const absolute = resolve(cwd ?? process.cwd(), path);
	try {
		const real = await realpath(absolute);
		const info = await stat(real);
		if (!info.isFile()) return `${path} is not a regular file.`;
		return { path: real, size: info.size };
	} catch {
		return `File not found or not readable: ${path}`;
	}
}

async function isSendablePhoto(path: string, size: number): Promise<boolean> {
	if (size > PHOTO_LIMIT_BYTES) return false;
	const handle = await open(path, "r");
	try {
		const header = Buffer.alloc(64 * 1024);
		const { bytesRead } = await handle.read(header, 0, header.length, 0);
		const probe = probeImage(header.subarray(0, bytesRead));
		if (probe === undefined || probe.mime === "image/gif") return false;
		return (probe.width ?? 0) + (probe.height ?? 0) <= 10_000;
	} finally {
		await handle.close();
	}
}

type Upload = {
	chatId: number;
	threadId?: number;
	path: string;
	size: number;
	caption: string | undefined;
	asPhoto: boolean;
};

async function upload(job: Upload, deps: SendFileDeps, context: Context): Promise<ToolExecutionResult> {
	const port = deps.port();
	const signal = context.abortSignal;
	await port
		.sendChatAction(job.chatId, job.asPhoto ? "upload_photo" : "upload_document", signal, job.threadId)
		.catch(() => undefined);
	try {
		const kind = await sendOnce(port, job, signal);
		return { output: [{ type: "text", text: `Sent ${basename(job.path)} (${mb(job.size)} MB) as ${kind}.` }] };
	} catch (error) {
		deps.log.warn("send_file_failed", telegramErrorSummary(error));
		return failure(uploadFailureText(error));
	}
}

async function sendOnce(
	port: TelegramPort,
	job: Upload,
	signal: AbortSignal | undefined,
): Promise<"photo" | "document"> {
	if (job.asPhoto) {
		try {
			await port.sendPhoto(job.chatId, job.path, job.caption, signal, job.threadId);
			return "photo";
		} catch (error) {
			// Telegram rejects some valid images as photos (dimensions, format); a document always works.
			if (classifyTelegramError(error).kind !== "rejected") throw error;
		}
	}
	await port.sendDocument(job.chatId, job.path, job.caption, signal, job.threadId);
	return "document";
}

function uploadFailureText(error: unknown): string {
	const kind = classifyTelegramError(error);
	if (kind.kind === "unknown") {
		return "Send outcome unknown (network error): the file may or may not have been delivered. Do not resend blindly; ask the user.";
	}
	if (kind.kind === "too_big") return "Telegram rejected the file as too big.";
	if (kind.kind === "rejected") return `Telegram rejected the file: ${kind.description}`;
	return "Sending failed: Telegram is unavailable. Try again later.";
}

function mb(bytes: number): string {
	return (bytes / 1_048_576).toFixed(1);
}
