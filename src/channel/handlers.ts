import { open } from "node:fs/promises";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import type { Message, Update } from "grammy/types";
import { probeImage } from "../agent/tools/image-probe.ts";
import { truncate } from "../format/escape.ts";
import { contextLine } from "../format/rich.ts";
import {
	type Attachment,
	attachmentNote,
	attachmentOf,
	inboxPath,
	missingAttachmentNote,
	otherNote,
} from "../media/attachments.ts";
import { type Stt, SttError, sttFailureText } from "../media/stt.ts";
import { isFatalHarnessError } from "../runtime/fatal.ts";
import { errorSummary } from "../runtime/log.ts";
import { DownloadError, downloadToFile, downloadToMemory } from "../telegram/download.ts";
import { checkAccess } from "./access.ts";
import { classifyMessage, isTopicServiceOnly } from "./classify.ts";
import { runCompact } from "./commands/compact.ts";
import { runNew } from "./commands/new.ts";
import { runHelp } from "./commands/start-help.ts";
import { runStatus } from "./commands/status.ts";
import { runStop } from "./commands/stop.ts";
import { Buttons, messageKey } from "./docs.ts";
import { draftScope } from "./draft-stop.ts";
import { admit, type DuplicateReason, knownAs } from "./intake.ts";
import { forwardMarker } from "./provenance.ts";
import { type ChannelRuntime, type MessageScope, reply } from "./scope.ts";
import { handleTap } from "./tap.ts";
import { rememberTopicName } from "./topic-names.ts";

const MB = 1024 * 1024;

/**
 * Handle one update: access gate, then a button tap, or a duplicate check and a command, text, attachment or voice
 * path that ends by admitting a delivery task. A draft's stop button runs /stop. Whatever an allowed user sends reaches the model: a file is saved and named, anything
 * else is described; the model decides what to do with it. Never awaits a model run; long commands run detached.
 * Never throws.
 */
export async function handleUpdate(rt: ChannelRuntime, update: Update): Promise<void> {
	try {
		await route(rt, update);
	} catch (error) {
		if (isFatalHarnessError(error)) rt.onFatal("storage failure while handling an update", error);
		else rt.log.error("update_failed", { update_id: update.update_id, error: errorSummary(error) });
	}
}

async function route(rt: ChannelRuntime, update: Update): Promise<void> {
	const access = checkAccess(update, rt.allowed);
	if (!access.allowed) {
		rt.log.info("update_ignored", access.fields);
		return;
	}
	if (update.callback_query !== undefined) return handleTap(rt, update.callback_query);
	if (update.stopped_message_generation !== undefined) {
		const draft = update.stopped_message_generation;
		return stopFromDraft(rt, access.chatId, draft.draft_id, update.update_id);
	}
	const message = update.message as Message;
	if (isTopicServiceOnly(message)) return rememberTopicName(rt.harness, message, BG);
	const scope = await scopeFor(rt, message, update.update_id);
	const reason = await knownAs(rt.harness, scope.conversation, scope.key, update.update_id, BG);
	if (reason !== undefined) return logDuplicate(scope, reason);
	await dispatch(scope);
}

async function scopeFor(rt: ChannelRuntime, message: Message, updateId: number): Promise<MessageScope> {
	const chatId = message.chat.id;
	const threadId = message.message_thread_id;
	const conversation = await rt.directory.get(chatId, BG, threadId);
	return {
		rt,
		conversation,
		message,
		chatId,
		...(threadId === undefined ? {} : { threadId }),
		messageId: message.message_id,
		updateId,
		key: messageKey(chatId, message.message_id, message.date),
	};
}

/** A redelivery is routine; a known key under another update means a message was dropped that may be new. */
function logDuplicate(scope: MessageScope, reason: DuplicateReason | "admitted_concurrently"): void {
	const fields = { update_id: scope.updateId, chat: scope.chatId, message: scope.messageId, reason };
	if (reason === "other_update") scope.rt.log.warn("update_duplicate", fields);
	else scope.rt.log.info("update_duplicate", fields);
}

async function dispatch(scope: MessageScope): Promise<void> {
	const classified = classifyMessage(scope.message);
	switch (classified.kind) {
		case "command":
			// A forwarded "/new" is someone else's text, not the user's command.
			if (forwardMarker(scope.message) === undefined) return runCommand(scope, classified.name, classified.args);
			await admitContent(scope, scope.message.text ?? "");
			return;
		case "text":
			await admitContent(scope, classified.text);
			return;
		case "file":
			return handleAttachment(scope);
		case "voice":
			return handleVoice(scope);
		default:
			await admitContent(scope, otherNote(scope.message));
			return;
	}
}

async function runCommand(scope: MessageScope, name: string, args: string): Promise<void> {
	switch (name) {
		case "start":
		case "help":
			return runHelp(scope);
		case "status":
			return runStatus(scope);
		case "new":
			return detach(scope, "new", () => runNew(scope));
		case "stop":
			return detach(scope, "stop", () => runStop(scope));
		case "compact":
			return detach(scope, "compact", () => runCompact(scope, args));
		default:
			// Unknown commands go to the model as text: skills and prompts often use their own slash words.
			await admitContent(scope, scope.message.text ?? `/${name}`);
			return;
	}
}

/** The stop button of a draft does what /stop does; the update id keeps a redelivered stop from running twice. */
async function stopFromDraft(rt: ChannelRuntime, chatId: number, draftId: number, updateId: number): Promise<void> {
	const draft = await draftScope(rt, chatId, draftId, updateId);
	if (draft === undefined) return;
	detach(draft.scope, "stop", () => runStop(draft.scope, draft.submissionId));
}

/** Commands that wait on durable work run outside the update handler, so polling (and a later /stop) continues. */
function detach(scope: Pick<MessageScope, "rt">, name: string, work: () => Promise<void>): void {
	scope.rt.track(
		work().catch((error: unknown) => {
			if (isFatalHarnessError(error)) scope.rt.onFatal(`storage failure in /${name}`, error);
			else scope.rt.log.error("command_failed", { command: name, error: errorSummary(error) });
		}),
	);
}

/** Admit the message for a model run; true when this call admitted it (false: a duplicate). */
async function admitContent(scope: MessageScope, text: string): Promise<boolean> {
	const marker = forwardMarker(scope.message);
	const content = (marker === undefined ? text : `${marker}\n${text}`) + (await replyContext(scope));
	const input = {
		chatId: scope.chatId,
		messageId: scope.messageId,
		requestId: scope.key,
		content,
		...(scope.threadId === undefined ? {} : { threadId: scope.threadId }),
	};
	const result = await admit(scope.conversation, scope.rt.deliver, input, BG, scope.updateId);
	if (result === "admitted") scope.rt.log.info("message_admitted", { chat: scope.chatId, message: scope.messageId });
	else logDuplicate(scope, "admitted_concurrently");
	return result === "admitted";
}

/** A reply carries the selected quote, or the original message using the same snapshot and limit as a tap. */
async function replyContext(scope: MessageScope): Promise<string> {
	const original = scope.message.reply_to_message;
	if (original === undefined) return "";
	const quote = scope.message.quote;
	if (quote !== undefined) return `\n\n(reply quoting: «${contextLine(quote.text, 1500)}»)`;
	const sent = original.from?.is_bot
		? (await scope.rt.harness.snapshot(Buttons, scope.conversation.id, BG))?.messages[String(original.message_id)]
		: undefined;
	const context = contextLine(sent ?? original.text ?? original.caption ?? "", 1500);
	if (context === "") return "";
	const name = contextLine(
		original.from === undefined ? "unknown" : `${original.from.first_name} ${original.from.last_name ?? ""}`,
		64,
	);
	const source = original.from?.is_bot ? "your message" : `message from ${name}`;
	return `\n\n(reply to ${source}: «${context}»)`;
}

/** Save the file and tell the model where it is; a file that cannot be fetched is still reported to the model. */
async function handleAttachment(scope: MessageScope, note?: string): Promise<void> {
	const attachment = attachmentOf(scope.message);
	if (attachment === undefined) {
		await admitContent(scope, otherNote(scope.message));
		return;
	}
	const caption = scope.message.caption;
	const limit = scope.rt.downloadLimit;
	if ((attachment.fileSize ?? 0) > limit) {
		const reason = `bots can download files up to ${Math.round(limit / MB)} MB`;
		await admitContent(scope, missingAttachmentNote({ attachment, reason, caption }));
		return;
	}
	const path = inboxPath(scope.rt.workdir, scope.rt.now(), scope.messageId, attachment.name);
	const failure = await saveAttachment(scope, attachment, path);
	if (failure !== undefined) {
		await admitContent(scope, missingAttachmentNote({ attachment, reason: failure, caption }));
		return;
	}
	const isImage = attachment.kind === "photo" || (await sniffImage(path));
	const kind = attachment.kind;
	await admitContent(
		scope,
		attachmentNote({
			kind,
			workdir: scope.rt.workdir,
			path,
			isImage,
			caption,
			...(note === undefined ? {} : { note }),
		}),
	);
}

/** Download into the inbox; returns the reason when it fails. */
async function saveAttachment(scope: MessageScope, attachment: Attachment, path: string): Promise<string | undefined> {
	try {
		await downloadToFile({ port: scope.rt.port, fileId: attachment.fileId, limit: scope.rt.downloadLimit }, path);
		return undefined;
	} catch (error) {
		scope.rt.log.warn("download_failed", { chat: scope.chatId, error: errorSummary(error) });
		return error instanceof DownloadError ? error.message : "the download failed";
	}
}

async function sniffImage(path: string): Promise<boolean> {
	const handle = await open(path, "r");
	try {
		const header = Buffer.alloc(4096);
		const { bytesRead } = await handle.read(header, 0, header.length, 0);
		return probeImage(header.subarray(0, bytesRead)) !== undefined;
	} finally {
		await handle.close();
	}
}

/**
 * Speech becomes text when speech-to-text is configured and works. Otherwise the audio is saved like any other file
 * and the model is told why there is no transcript.
 */
async function handleVoice(scope: MessageScope): Promise<void> {
	const voice = attachmentOf(scope.message);
	const stt = scope.rt.stt;
	if (voice === undefined || stt === undefined) {
		return handleAttachment(scope, "No transcript: speech-to-text is not configured (DEEPGRAM_API_KEY).");
	}
	if ((voice.fileSize ?? 0) > scope.rt.downloadLimit) return handleAttachment(scope);
	const result = await transcribe(scope, stt, voice.fileId, voice.mime ?? "audio/ogg");
	if (typeof result === "string") return handleAttachment(scope, `No transcript: ${result}`);
	const lang = result.language === undefined ? "" : `, lang=${result.language}`;
	// Echo only once admitted: a redelivered voice message (shutdown or crash before admit) is not echoed twice.
	if (await admitContent(scope, `[voice transcript${lang}] ${result.text}`))
		await reply(scope, `🎙 ${truncate(result.text, 4000)}`);
}

/** The transcript, or the reason there is none. */
async function transcribe(scope: MessageScope, stt: Stt, fileId: string, mime: string) {
	try {
		const bytes = await downloadToMemory({ port: scope.rt.port, fileId, limit: scope.rt.downloadLimit });
		const transcript = await stt.transcribe(bytes, mime, AbortSignal.timeout(90_000));
		return transcript.text === "" ? "no speech was recognized." : transcript;
	} catch (error) {
		scope.rt.log.warn("voice_failed", { chat: scope.chatId, error: errorSummary(error) });
		return error instanceof SttError ? sttFailureText(error.kind) : "the audio could not be downloaded.";
	}
}
