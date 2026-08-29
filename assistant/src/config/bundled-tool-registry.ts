/**
 * Auto-generated registry of bundled skill tool scripts.
 *
 * In compiled Bun binaries, bundled tool scripts can't be dynamically
 * imported from the filesystem because their relative imports point to
 * modules that only exist inside the binary's virtual /$bunfs/ filesystem.
 *
 * This registry eagerly imports every bundled tool script so it becomes
 * part of the compiled binary.  At runtime, the skill-script-runner
 * checks this map before falling back to a dynamic import.
 *
 * Regenerate with:
 *   bun run scripts/generate-bundled-tool-registry.ts
 */
import type { SkillToolScript } from "../tools/skills/script-contract.js";
// ── acp ────────────────────────────────────────────────────────────────────────
import * as acpAbort from "./bundled-skills/acp/tools/acp-abort.js";
import * as acpListAgents from "./bundled-skills/acp/tools/acp-list-agents.js";
import * as acpSpawn from "./bundled-skills/acp/tools/acp-spawn.js";
import * as acpStatus from "./bundled-skills/acp/tools/acp-status.js";
import * as acpSteer from "./bundled-skills/acp/tools/acp-steer.js";
// ── apify ──────────────────────────────────────────────────────────────────────
import * as apifyRunActor from "./bundled-skills/apify/tools/apify-run-actor.js";
// ── app-builder ────────────────────────────────────────────────────────────────
import * as appCreate from "./bundled-skills/app-builder/tools/app-create.js";
import * as appDelete from "./bundled-skills/app-builder/tools/app-delete.js";
import * as appGenerateIcon from "./bundled-skills/app-builder/tools/app-generate-icon.js";
import * as appList from "./bundled-skills/app-builder/tools/app-list.js";
import * as appBuilder_appRefresh from "./bundled-skills/app-builder/tools/app-refresh.js";
import * as appUpdate from "./bundled-skills/app-builder/tools/app-update.js";
import * as deckExportPdf from "./bundled-skills/app-builder/tools/deck-export-pdf.js";
import * as deckTemplateLoad from "./bundled-skills/app-builder/tools/deck-template-load.js";
// ── app-control ────────────────────────────────────────────────────────────────
import * as appControlClick from "./bundled-skills/app-control/tools/app-control-click.js";
import * as appControlCombo from "./bundled-skills/app-control/tools/app-control-combo.js";
import * as appControlDrag from "./bundled-skills/app-control/tools/app-control-drag.js";
import * as appControlObserve from "./bundled-skills/app-control/tools/app-control-observe.js";
import * as appControlPress from "./bundled-skills/app-control/tools/app-control-press.js";
import * as appControlSequence from "./bundled-skills/app-control/tools/app-control-sequence.js";
import * as appControlStart from "./bundled-skills/app-control/tools/app-control-start.js";
import * as appControlStop from "./bundled-skills/app-control/tools/app-control-stop.js";
import * as appControlType from "./bundled-skills/app-control/tools/app-control-type.js";
// ── computer-use ───────────────────────────────────────────────────────────────
import * as computerUseClick from "./bundled-skills/computer-use/tools/computer-use-click.js";
import * as computerUseDone from "./bundled-skills/computer-use/tools/computer-use-done.js";
import * as computerUseDrag from "./bundled-skills/computer-use/tools/computer-use-drag.js";
import * as computerUseKey from "./bundled-skills/computer-use/tools/computer-use-key.js";
import * as computerUseObserve from "./bundled-skills/computer-use/tools/computer-use-observe.js";
import * as computerUseOpenApp from "./bundled-skills/computer-use/tools/computer-use-open-app.js";
import * as computerUseRespond from "./bundled-skills/computer-use/tools/computer-use-respond.js";
import * as computerUseRunApplescript from "./bundled-skills/computer-use/tools/computer-use-run-applescript.js";
import * as computerUseScroll from "./bundled-skills/computer-use/tools/computer-use-scroll.js";
import * as computerUseTypeText from "./bundled-skills/computer-use/tools/computer-use-type-text.js";
import * as computerUseWait from "./bundled-skills/computer-use/tools/computer-use-wait.js";
// ── contacts ───────────────────────────────────────────────────────────────────
import * as contactMerge from "./bundled-skills/contacts/tools/contact-merge.js";
import * as contactSearch from "./bundled-skills/contacts/tools/contact-search.js";
import * as googleContacts from "./bundled-skills/contacts/tools/google-contacts.js";
// ── document-editor ────────────────────────────────────────────────────────────
import * as commentList from "./bundled-skills/document-editor/tools/comment-list.js";
import * as commentReply from "./bundled-skills/document-editor/tools/comment-reply.js";
import * as commentResolve from "./bundled-skills/document-editor/tools/comment-resolve.js";
import * as documentCreate from "./bundled-skills/document-editor/tools/document-create.js";
import * as documentDelete from "./bundled-skills/document-editor/tools/document-delete.js";
import * as documentExport from "./bundled-skills/document-editor/tools/document-export.js";
import * as documentExportPdf from "./bundled-skills/document-editor/tools/document-export-pdf.js";
import * as documentFind from "./bundled-skills/document-editor/tools/document-find.js";
import * as documentList from "./bundled-skills/document-editor/tools/document-list.js";
import * as documentOpen from "./bundled-skills/document-editor/tools/document-open.js";
import * as documentRead from "./bundled-skills/document-editor/tools/document-read.js";
import * as documentReplaceText from "./bundled-skills/document-editor/tools/document-replace-text.js";
import * as documentSend from "./bundled-skills/document-editor/tools/document-send.js";
import * as documentUpdate from "./bundled-skills/document-editor/tools/document-update.js";
import * as fileCreate from "./bundled-skills/document-editor/tools/file-create.js";
import * as pdfCreate from "./bundled-skills/document-editor/tools/pdf-create.js";
// ── followups ──────────────────────────────────────────────────────────────────
import * as followupCreate from "./bundled-skills/followups/tools/followup-create.js";
import * as followupList from "./bundled-skills/followups/tools/followup-list.js";
import * as followupResolve from "./bundled-skills/followups/tools/followup-resolve.js";
// ── image-studio ───────────────────────────────────────────────────────────────
import * as mediaGenerateImage from "./bundled-skills/image-studio/tools/media-generate-image.js";
// ── media-processing ───────────────────────────────────────────────────────────
import * as analyzeKeyframes from "./bundled-skills/media-processing/tools/analyze-keyframes.js";
import * as extractKeyframes from "./bundled-skills/media-processing/tools/extract-keyframes.js";
import * as generateClip from "./bundled-skills/media-processing/tools/generate-clip.js";
import * as ingestMedia from "./bundled-skills/media-processing/tools/ingest-media.js";
import * as mediaStatus from "./bundled-skills/media-processing/tools/media-status.js";
import * as queryMediaEvents from "./bundled-skills/media-processing/tools/query-media-events.js";
// ── messaging ──────────────────────────────────────────────────────────────────
import * as inboxRunReport from "./bundled-skills/messaging/tools/inbox-run-report.js";
import * as messagingAnalyzeStyle from "./bundled-skills/messaging/tools/messaging-analyze-style.js";
import * as messagingArchiveBySender from "./bundled-skills/messaging/tools/messaging-archive-by-sender.js";
import * as messagingAuthTest from "./bundled-skills/messaging/tools/messaging-auth-test.js";
import * as messagingDraft from "./bundled-skills/messaging/tools/messaging-draft.js";
import * as messagingListConversations from "./bundled-skills/messaging/tools/messaging-list-conversations.js";
import * as messagingMarkImportant from "./bundled-skills/messaging/tools/messaging-mark-important.js";
import * as messagingMarkRead from "./bundled-skills/messaging/tools/messaging-mark-read.js";
import * as messagingRead from "./bundled-skills/messaging/tools/messaging-read.js";
import * as messagingSearch from "./bundled-skills/messaging/tools/messaging-search.js";
import * as messagingSend from "./bundled-skills/messaging/tools/messaging-send.js";
import * as messagingSenderDigest from "./bundled-skills/messaging/tools/messaging-sender-digest.js";
// ── personal-page ──────────────────────────────────────────────────────────────
import * as personalPage_appRefresh from "./bundled-skills/personal-page/tools/app-refresh.js";
// ── phone-calls ────────────────────────────────────────────────────────────────
import * as callEnd from "./bundled-skills/phone-calls/tools/call-end.js";
import * as callStart from "./bundled-skills/phone-calls/tools/call-start.js";
import * as callStatus from "./bundled-skills/phone-calls/tools/call-status.js";
// ── playbooks ──────────────────────────────────────────────────────────────────
import * as playbookCreate from "./bundled-skills/playbooks/tools/playbook-create.js";
import * as playbookDelete from "./bundled-skills/playbooks/tools/playbook-delete.js";
import * as playbookList from "./bundled-skills/playbooks/tools/playbook-list.js";
import * as playbookUpdate from "./bundled-skills/playbooks/tools/playbook-update.js";
// ── replicate ──────────────────────────────────────────────────────────────────
import * as replicateRun from "./bundled-skills/replicate/tools/replicate-run.js";
// ── schedule ───────────────────────────────────────────────────────────────────
import * as scheduleCreate from "./bundled-skills/schedule/tools/schedule-create.js";
import * as scheduleDelete from "./bundled-skills/schedule/tools/schedule-delete.js";
import * as scheduleList from "./bundled-skills/schedule/tools/schedule-list.js";
import * as scheduleUpdate from "./bundled-skills/schedule/tools/schedule-update.js";
// ── sequences ──────────────────────────────────────────────────────────────────
import * as sequenceAnalytics from "./bundled-skills/sequences/tools/sequence-analytics.js";
import * as sequenceCreate from "./bundled-skills/sequences/tools/sequence-create.js";
import * as sequenceDelete from "./bundled-skills/sequences/tools/sequence-delete.js";
import * as sequenceEnroll from "./bundled-skills/sequences/tools/sequence-enroll.js";
import * as sequenceEnrollmentList from "./bundled-skills/sequences/tools/sequence-enrollment-list.js";
import * as sequenceGet from "./bundled-skills/sequences/tools/sequence-get.js";
import * as sequenceImport from "./bundled-skills/sequences/tools/sequence-import.js";
import * as sequenceList from "./bundled-skills/sequences/tools/sequence-list.js";
import * as sequenceUpdate from "./bundled-skills/sequences/tools/sequence-update.js";
// ── settings ───────────────────────────────────────────────────────────────────
import * as navigateSettingsTab from "./bundled-skills/settings/tools/navigate-settings-tab.js";
import * as openSystemSettings from "./bundled-skills/settings/tools/open-system-settings.js";
import * as voiceConfigUpdate from "./bundled-skills/settings/tools/voice-config-update.js";
// ── skill-management ───────────────────────────────────────────────────────────
import * as deleteManaged from "./bundled-skills/skill-management/tools/delete-managed.js";
import * as scaffoldManaged from "./bundled-skills/skill-management/tools/scaffold-managed.js";
import * as teachSkill from "./bundled-skills/skill-management/tools/teach.js";
// ── spreadsheet-studio ─────────────────────────────────────────────────────────
import * as spreadsheetCreate from "./bundled-skills/spreadsheet-studio/tools/spreadsheet-create.js";
// ── subagent ───────────────────────────────────────────────────────────────────
import * as subagentAbort from "./bundled-skills/subagent/tools/subagent-abort.js";
import * as subagentMessage from "./bundled-skills/subagent/tools/subagent-message.js";
import * as subagentRead from "./bundled-skills/subagent/tools/subagent-read.js";
import * as subagentSpawn from "./bundled-skills/subagent/tools/subagent-spawn.js";
import * as subagentStatus from "./bundled-skills/subagent/tools/subagent-status.js";
// ── tasks ──────────────────────────────────────────────────────────────────────
import * as taskListAdd from "./bundled-skills/tasks/tools/task-list-add.js";
import * as taskListRemove from "./bundled-skills/tasks/tools/task-list-remove.js";
import * as taskListShow from "./bundled-skills/tasks/tools/task-list-show.js";
import * as taskListUpdate from "./bundled-skills/tasks/tools/task-list-update.js";
import * as taskQueueRun from "./bundled-skills/tasks/tools/task-queue-run.js";
// ── transcribe ─────────────────────────────────────────────────────────────────
import * as transcribeMedia from "./bundled-skills/transcribe/tools/transcribe-media.js";
// ── video-studio ───────────────────────────────────────────────────────────────
import * as videoCompose from "./bundled-skills/video-studio/tools/video-compose.js";
// ── web-research ───────────────────────────────────────────────────────────────
import * as serperImages from "./bundled-skills/web-research/tools/serper-images.js";
import * as serperSearch from "./bundled-skills/web-research/tools/serper-search.js";
import * as tavilySearch from "./bundled-skills/web-research/tools/tavily-search.js";
// ── web-scrape ─────────────────────────────────────────────────────────────────
import * as firecrawlCrawl from "./bundled-skills/web-scrape/tools/firecrawl-crawl.js";
import * as firecrawlScrape from "./bundled-skills/web-scrape/tools/firecrawl-scrape.js";

// ─── Registry ────────────────────────────────────────────────────────────────

/** Key format: `skillDirBasename:executorPath` (e.g. `schedule:tools/schedule-list.ts`). */
export const bundledToolRegistry = new Map<string, SkillToolScript>([
  // acp
  ["acp:tools/acp-spawn.ts", acpSpawn],
  ["acp:tools/acp-status.ts", acpStatus],
  ["acp:tools/acp-abort.ts", acpAbort],
  ["acp:tools/acp-steer.ts", acpSteer],
  ["acp:tools/acp-list-agents.ts", acpListAgents],

  // apify
  ["apify:tools/apify-run-actor.ts", apifyRunActor],

  // app-builder
  ["app-builder:tools/app-create.ts", appCreate],
  ["app-builder:tools/app-update.ts", appUpdate],
  ["app-builder:tools/app-delete.ts", appDelete],
  ["app-builder:tools/app-refresh.ts", appBuilder_appRefresh],
  ["app-builder:tools/app-generate-icon.ts", appGenerateIcon],
  ["app-builder:tools/app-list.ts", appList],
  ["app-builder:tools/deck-export-pdf.ts", deckExportPdf],
  ["app-builder:tools/deck-template-load.ts", deckTemplateLoad],

  // app-control
  ["app-control:tools/app-control-start.ts", appControlStart],
  ["app-control:tools/app-control-observe.ts", appControlObserve],
  ["app-control:tools/app-control-press.ts", appControlPress],
  ["app-control:tools/app-control-combo.ts", appControlCombo],
  ["app-control:tools/app-control-sequence.ts", appControlSequence],
  ["app-control:tools/app-control-type.ts", appControlType],
  ["app-control:tools/app-control-click.ts", appControlClick],
  ["app-control:tools/app-control-drag.ts", appControlDrag],
  ["app-control:tools/app-control-stop.ts", appControlStop],

  // computer-use
  ["computer-use:tools/computer-use-observe.ts", computerUseObserve],
  ["computer-use:tools/computer-use-click.ts", computerUseClick],
  ["computer-use:tools/computer-use-type-text.ts", computerUseTypeText],
  ["computer-use:tools/computer-use-key.ts", computerUseKey],
  ["computer-use:tools/computer-use-scroll.ts", computerUseScroll],
  ["computer-use:tools/computer-use-drag.ts", computerUseDrag],
  ["computer-use:tools/computer-use-wait.ts", computerUseWait],
  ["computer-use:tools/computer-use-open-app.ts", computerUseOpenApp],
  [
    "computer-use:tools/computer-use-run-applescript.ts",
    computerUseRunApplescript,
  ],
  ["computer-use:tools/computer-use-done.ts", computerUseDone],
  ["computer-use:tools/computer-use-respond.ts", computerUseRespond],

  // contacts
  ["contacts:tools/contact-search.ts", contactSearch],
  ["contacts:tools/contact-merge.ts", contactMerge],
  ["contacts:tools/google-contacts.ts", googleContacts],

  // document-editor
  ["document-editor:tools/document-open.ts", documentOpen],
  ["document-editor:tools/document-create.ts", documentCreate],
  ["document-editor:tools/document-update.ts", documentUpdate],
  ["document-editor:tools/document-read.ts", documentRead],
  ["document-editor:tools/document-list.ts", documentList],
  ["document-editor:tools/document-delete.ts", documentDelete],
  ["document-editor:tools/document-find.ts", documentFind],
  ["document-editor:tools/document-replace-text.ts", documentReplaceText],
  ["document-editor:tools/comment-list.ts", commentList],
  ["document-editor:tools/comment-resolve.ts", commentResolve],
  ["document-editor:tools/comment-reply.ts", commentReply],
  ["document-editor:tools/document-export-pdf.ts", documentExportPdf],
  ["document-editor:tools/document-export.ts", documentExport],
  ["document-editor:tools/document-send.ts", documentSend],
  ["document-editor:tools/pdf-create.ts", pdfCreate],
  ["document-editor:tools/file-create.ts", fileCreate],

  // followups
  ["followups:tools/followup-create.ts", followupCreate],
  ["followups:tools/followup-list.ts", followupList],
  ["followups:tools/followup-resolve.ts", followupResolve],

  // image-studio
  ["image-studio:tools/media-generate-image.ts", mediaGenerateImage],

  // media-processing
  ["media-processing:tools/ingest-media.ts", ingestMedia],
  ["media-processing:tools/media-status.ts", mediaStatus],
  ["media-processing:tools/extract-keyframes.ts", extractKeyframes],
  ["media-processing:tools/analyze-keyframes.ts", analyzeKeyframes],
  ["media-processing:tools/query-media-events.ts", queryMediaEvents],
  ["media-processing:tools/generate-clip.ts", generateClip],

  // messaging
  ["messaging:tools/messaging-auth-test.ts", messagingAuthTest],
  [
    "messaging:tools/messaging-list-conversations.ts",
    messagingListConversations,
  ],
  ["messaging:tools/messaging-read.ts", messagingRead],
  ["messaging:tools/messaging-search.ts", messagingSearch],
  ["messaging:tools/messaging-send.ts", messagingSend],
  ["messaging:tools/messaging-mark-read.ts", messagingMarkRead],
  ["messaging:tools/messaging-analyze-style.ts", messagingAnalyzeStyle],
  ["messaging:tools/messaging-draft.ts", messagingDraft],
  ["messaging:tools/messaging-sender-digest.ts", messagingSenderDigest],
  ["messaging:tools/messaging-archive-by-sender.ts", messagingArchiveBySender],
  ["messaging:tools/messaging-mark-important.ts", messagingMarkImportant],
  ["messaging:tools/inbox-run-report.ts", inboxRunReport],

  // personal-page
  ["personal-page:tools/app-refresh.ts", personalPage_appRefresh],

  // phone-calls
  ["phone-calls:tools/call-start.ts", callStart],
  ["phone-calls:tools/call-status.ts", callStatus],
  ["phone-calls:tools/call-end.ts", callEnd],

  // playbooks
  ["playbooks:tools/playbook-create.ts", playbookCreate],
  ["playbooks:tools/playbook-list.ts", playbookList],
  ["playbooks:tools/playbook-update.ts", playbookUpdate],
  ["playbooks:tools/playbook-delete.ts", playbookDelete],

  // replicate
  ["replicate:tools/replicate-run.ts", replicateRun],

  // schedule
  ["schedule:tools/schedule-create.ts", scheduleCreate],
  ["schedule:tools/schedule-list.ts", scheduleList],
  ["schedule:tools/schedule-update.ts", scheduleUpdate],
  ["schedule:tools/schedule-delete.ts", scheduleDelete],

  // sequences
  ["sequences:tools/sequence-create.ts", sequenceCreate],
  ["sequences:tools/sequence-list.ts", sequenceList],
  ["sequences:tools/sequence-get.ts", sequenceGet],
  ["sequences:tools/sequence-update.ts", sequenceUpdate],
  ["sequences:tools/sequence-delete.ts", sequenceDelete],
  ["sequences:tools/sequence-enroll.ts", sequenceEnroll],
  ["sequences:tools/sequence-enrollment-list.ts", sequenceEnrollmentList],
  ["sequences:tools/sequence-import.ts", sequenceImport],
  ["sequences:tools/sequence-analytics.ts", sequenceAnalytics],

  // settings
  ["settings:tools/voice-config-update.ts", voiceConfigUpdate],
  ["settings:tools/open-system-settings.ts", openSystemSettings],
  ["settings:tools/navigate-settings-tab.ts", navigateSettingsTab],

  // skill-management
  ["skill-management:tools/scaffold-managed.ts", scaffoldManaged],
  ["skill-management:tools/teach.ts", teachSkill],
  ["skill-management:tools/delete-managed.ts", deleteManaged],

  // spreadsheet-studio
  ["spreadsheet-studio:tools/spreadsheet-create.ts", spreadsheetCreate],

  // subagent
  ["subagent:tools/subagent-spawn.ts", subagentSpawn],
  ["subagent:tools/subagent-status.ts", subagentStatus],
  ["subagent:tools/subagent-abort.ts", subagentAbort],
  ["subagent:tools/subagent-message.ts", subagentMessage],
  ["subagent:tools/subagent-read.ts", subagentRead],

  // tasks
  ["tasks:tools/task-list-add.ts", taskListAdd],
  ["tasks:tools/task-list-show.ts", taskListShow],
  ["tasks:tools/task-list-update.ts", taskListUpdate],
  ["tasks:tools/task-list-remove.ts", taskListRemove],
  ["tasks:tools/task-queue-run.ts", taskQueueRun],

  // transcribe
  ["transcribe:tools/transcribe-media.ts", transcribeMedia],

  // video-studio
  ["video-studio:tools/video-compose.ts", videoCompose],

  // web-research
  ["web-research:tools/tavily-search.ts", tavilySearch],
  ["web-research:tools/serper-search.ts", serperSearch],
  ["web-research:tools/serper-images.ts", serperImages],

  // web-scrape
  ["web-scrape:tools/firecrawl-scrape.ts", firecrawlScrape],
  ["web-scrape:tools/firecrawl-crawl.ts", firecrawlCrawl],
]);
