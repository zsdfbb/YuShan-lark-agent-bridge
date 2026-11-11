export type BridgePromptSource = 'im' | 'card' | 'comment';

export interface BridgePromptMention {
  openId?: string;
  name?: string;
  isBot?: boolean;
}

export interface BridgePromptContext {
  chatId: string;
  chatType: string;
  senderId: string;
  senderName?: string;
  /** Whether the sender is a human user or another bot ('app' sender). */
  senderType?: 'user' | 'bot';
  /** The bridge bot's own open_id — "this id is you" for self-identification. */
  botOpenId?: string;
  /** Accounts @-mentioned in the triggering message(s), deduped across the batch. */
  mentions?: BridgePromptMention[];
  threadId?: string;
  messageIds?: string[];
  source: BridgePromptSource;
}

export interface BridgePromptQuotedMessage {
  messageId: string;
  senderId: string;
  senderName?: string;
  createdAt?: string;
  rawContentType: string;
  content: string;
}

export interface BridgePromptInteractiveCard {
  messageId?: string;
  content: unknown;
}

/**
 * A prior message in the same Feishu topic, supplied as read-only context when
 * the bot is first pulled into a topic it hasn't been part of. Distinct from
 * `quotedMessages` (an explicit reply-quote): this is the topic's upstream
 * conversation the bot would otherwise be blind to.
 */
export interface BridgePromptTopicMessage {
  messageId: string;
  senderId: string;
  senderName?: string;
  senderType?: 'user' | 'bot';
  createdAt?: string;
  rawContentType: string;
  content: string;
}

export interface BridgePromptComment {
  commentScopeId: string;
  isWholeDocument: boolean;
  docsLink?: string;
  question: string;
  quote?: string;
}

export interface BridgePromptAttachment {
  path: string;
  kind: string;
  hash?: string;
  size?: number;
  mime?: string;
  sourceMessageId?: string;
  requiredness?: 'required' | 'optional';
  decision?: 'accepted' | 'rejected' | 'skipped';
  rejectionReason?: string;
}

export interface BuildAgentPromptInput {
  context: BridgePromptContext;
  instructions?: string[];
  userInput: string;
  topicContext?: BridgePromptTopicMessage[];
  quotedMessages?: BridgePromptQuotedMessage[];
  interactiveCards?: BridgePromptInteractiveCard[];
  comment?: BridgePromptComment;
  attachments?: BridgePromptAttachment[];
  /**
   * Plain-text references for agents that cannot receive attachment files
   * themselves (yushan: no input-side image/file parsing). Rendered as a
   * trailing `## attachments` block after `user_input`.
   */
  attachmentRefs?: Array<{ kind: string; path: string }>;
}

export function buildAgentPrompt(input: BuildAgentPromptInput): string {
  const attachmentRefs = renderAttachmentRefs(input.attachmentRefs);
  const sections = [
    promptSection('bridge_context', input.context),
    input.instructions && input.instructions.length > 0
      ? promptSection('bridge_instructions', input.instructions)
      : undefined,
    input.topicContext && input.topicContext.length > 0
      ? promptSection('topic_context', input.topicContext)
      : undefined,
    input.quotedMessages && input.quotedMessages.length > 0
      ? promptSection('quoted_messages', input.quotedMessages)
      : undefined,
    input.interactiveCards && input.interactiveCards.length > 0
      ? promptSection('interactive_cards', input.interactiveCards)
      : undefined,
    input.comment ? promptSection('comment_context', input.comment) : undefined,
    promptSection('user_input', {
      text: input.userInput,
      ...(input.attachments && input.attachments.length > 0
        ? { attachments: input.attachments }
        : {}),
    }),
    attachmentRefs,
  ];

  return sections.filter(Boolean).join('\n\n');
}

/** Renders the `## attachments` block, or `undefined` when there is nothing to
 *  reference. Each line is exactly `- [<kind>: <path>]` — a stable shape agents
 *  can grep for. */
export function renderAttachmentRefs(
  refs: ReadonlyArray<{ kind: string; path: string }> | undefined,
): string | undefined {
  if (!refs || refs.length === 0) return undefined;
  return ['## attachments', '', ...refs.map((ref) => `- [${ref.kind}: ${ref.path}]`)].join('\n');
}

export function promptSection(tag: string, value: unknown): string {
  return `<${tag}>\n${safeJsonStringify(value)}\n</${tag}>`;
}

export function safeJsonStringify(value: unknown): string {
  return (JSON.stringify(value) ?? 'null')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
