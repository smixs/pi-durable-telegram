import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import type { CompactReportTask } from "../delivery/compact-report.ts";
import type { DeliverTask } from "../delivery/task.ts";
import { createReminderTask } from "../plugins/reminders/task.ts";
import type { Logger } from "../runtime/log.ts";
import type { TelegramPort } from "../telegram/port.ts";
import { createRenameTopicTool } from "../telegram/rename-topic.ts";
import { createSendFileTool } from "../telegram/send-file.ts";
import { createTopicNameSection, type TopicNamesMode } from "./topic-names.ts";

/**
 * The durable part of the channel: its task definitions and Telegram file/topic tools. The reminder task is here,
 * not in its plugin, so reminders left pending by a plugin that is now off never block startup.
 */
export function createTelegramExtension(options: {
	deliver: DeliverTask;
	compactReport: CompactReportTask;
	port: () => TelegramPort;
	log: Logger;
	allowed: ReadonlySet<number>;
	topicNames?: TopicNamesMode;
	uploadLimit?: number;
}): Extension {
	const sendFile = createSendFileTool({
		port: options.port,
		log: options.log,
		...(options.uploadLimit === undefined ? {} : { uploadLimit: options.uploadLimit }),
	});
	const topicNames = options.topicNames ?? "auto";
	const renameTopic = createRenameTopicTool({ port: options.port, log: options.log, topicNames });
	return defineExtension({
		name: "telegram",
		tasks: [options.deliver, options.compactReport, createReminderTask(options.allowed)],
		tools: [sendFile, renameTopic],
		sections: [createTopicNameSection(topicNames)],
	});
}
