// Surface types, UI surface lifecycle messages.

// === Surface type definitions ===

export type SurfaceType =
  | "card"
  | "choice"
  | "copy_block"
  | "oauth_connect"
  | "form"
  | "list"
  | "table"
  | "confirmation"
  | "dynamic_page"
  | "file_upload"
  | "document_preview"
  | "spreadsheet_preview"
  | "task_preferences"
  | "work_result"
  | "artefact"
  | "adjacent_offer";

export const INTERACTIVE_SURFACE_TYPES: SurfaceType[] = [
  "choice",
  "oauth_connect",
  "form",
  "confirmation",
  "dynamic_page",
  "file_upload",
  "task_preferences",
];

export interface SurfaceAction {
  id: string;
  label: string;
  style?: "primary" | "secondary" | "destructive";
  /** Optional data payload returned to the daemon when this action is clicked. */
  data?: Record<string, unknown>;
}

export interface CardSurfaceData {
  title: string;
  subtitle?: string;
  body: string;
  metadata?: Array<{ label: string; value: string }>;
  /** Optional template name for specialized rendering (e.g. "weather_forecast"). */
  template?: string;
  /** Arbitrary data consumed by the template renderer. Shape depends on template. */
  templateData?: Record<string, unknown>;
}

export interface ChoiceOption {
  id: string;
  title: string;
  description?: string;
  /** Visually highlight this option as the assistant's recommendation. */
  recommended?: boolean;
  /** Optional structured payload returned with this choice. */
  data?: Record<string, unknown>;
}

export interface ChoiceSurfaceData {
  description?: string;
  options: ChoiceOption[];
  selectionMode?: "single" | "multiple";
  /**
   * When true, clicking an option submits it immediately. Defaults to true for
   * single-select choice surfaces.
   */
  commitOnSelect?: boolean;
  submitLabel?: string;
}

export interface CopyBlockSurfaceData {
  text: string;
  label?: string;
  language?: string;
}

export interface OAuthConnectSurfaceData {
  /** OAuth provider key from the managed provider catalog, e.g. "google". */
  providerKey: string;
  /** Optional display label. The client falls back to the provider catalog. */
  displayName?: string;
  /** Optional helper text. The client falls back to the provider catalog. */
  description?: string;
  /** Optional provider logo URL. The client falls back to the provider catalog. */
  logoUrl?: string | null;
}

export interface FormField {
  id: string;
  type: "text" | "textarea" | "select" | "toggle" | "number" | "password";
  label: string;
  placeholder?: string;
  required?: boolean;
  defaultValue?: string | number | boolean;
  options?: Array<{ label: string; value: string }>;
}

export interface FormPage {
  id: string;
  title: string;
  description?: string;
  fields: FormField[];
}

export interface FormSurfaceData {
  description?: string;
  fields: FormField[];
  submitLabel?: string;
  pages?: FormPage[];
  pageLabels?: { next?: string; back?: string; submit?: string };
}

export interface ListItem {
  id: string;
  title: string;
  subtitle?: string;
  icon?: string;
  selected?: boolean;
}

export interface ListSurfaceData {
  items: ListItem[];
  selectionMode: "single" | "multiple" | "none";
}

export interface ConfirmationSurfaceData {
  message: string;
  detail?: string;
  confirmLabel?: string;
  confirmedLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

export interface DynamicPagePreview {
  title: string;
  subtitle?: string;
  description?: string;
  icon?: string;
  metrics?: Array<{ label: string; value: string }>;
  context?: "app_create" | "general";
  previewImage?: string; // base64 PNG
}

export interface DynamicPageSurfaceData {
  html: string;
  width?: number;
  height?: number;
  appId?: string;
  /** Filesystem directory name for this app (may differ from `appId`). */
  dirName?: string;
  reloadGeneration?: number;
  status?: string;
  preview?: DynamicPagePreview;
}

export interface FileUploadSurfaceData {
  prompt: string;
  acceptedTypes?: string[];
  maxFiles?: number;
  maxSizeBytes?: number;
}

export interface TableColumn {
  id: string;
  label: string;
  width?: number;
}

export interface TableCellValue {
  text: string;
  icon?: string; // SF Symbol name
  iconColor?: string; // semantic token: "success" | "warning" | "error" | "muted"
}

export interface TableRow {
  id: string;
  cells: Record<string, string | TableCellValue>;
  selectable?: boolean;
  selected?: boolean;
}

export interface TableSurfaceData {
  columns: TableColumn[];
  rows: TableRow[];
  selectionMode?: "none" | "single" | "multiple";
  caption?: string;
}

export interface DocumentPreviewSurfaceData {
  title: string;
  surfaceId: string; // the doc's real surfaceId, for focusing the panel
  subtitle?: string;
}

export interface SpreadsheetPreviewSheetSummary {
  name: string;
  rows: number;
  formulaCells: number;
}

export interface SpreadsheetPreviewSurfaceData {
  filename: string;
  /** Attachment id of the stored .xlsx; the client fetches its bytes on open. */
  attachmentId: string;
  sheets: SpreadsheetPreviewSheetSummary[];
  totalFormulaCells: number;
  sizeBytes?: number;
}

export type WorkResultStatus =
  | "completed"
  | "partial"
  | "failed"
  | "in_progress";

export type WorkResultTone = "neutral" | "positive" | "warning" | "negative";

export type WorkResultSectionType =
  | "items"
  | "timeline"
  | "diff"
  | "artifacts"
  | "warnings";

export interface WorkResultMetric {
  label: string;
  value: string | number;
  detail?: string;
  tone?: WorkResultTone;
}

export interface WorkResultMetadata {
  label: string;
  value: string | number;
}

export interface WorkResultItem {
  id?: string;
  title: string;
  description?: string;
  status?: string;
  tone?: WorkResultTone;
  metadata?: WorkResultMetadata[];
  href?: string;
}

export interface WorkResultDiff {
  label?: string;
  before?: string;
  after?: string;
}

export interface WorkResultSection {
  id?: string;
  title: string;
  description?: string;
  type?: WorkResultSectionType;
  items?: WorkResultItem[];
  diffs?: WorkResultDiff[];
}

export interface WorkResultSurfaceData {
  eyebrow?: string;
  status?: WorkResultStatus;
  summary?: string;
  metrics?: WorkResultMetric[];
  sections?: WorkResultSection[];
}

export type SurfaceData =
  | CardSurfaceData
  | ChoiceSurfaceData
  | CopyBlockSurfaceData
  | OAuthConnectSurfaceData
  | FormSurfaceData
  | ListSurfaceData
  | TableSurfaceData
  | ConfirmationSurfaceData
  | DynamicPageSurfaceData
  | FileUploadSurfaceData
  | DocumentPreviewSurfaceData
  | SpreadsheetPreviewSurfaceData
  | WorkResultSurfaceData;

// === Client → Server ===

export interface UiSurfaceAction {
  type: "ui_surface_action";
  conversationId: string;
  surfaceId: string;
  actionId: string;
  data?: Record<string, unknown>;
}

export interface UiSurfaceUndoRequest {
  type: "ui_surface_undo";
  conversationId: string;
  surfaceId: string;
}

// === Server → Client ===

/** Common fields shared by all UiSurfaceShow variants. */
interface UiSurfaceShowBase {
  type: "ui_surface_show";
  conversationId: string;
  surfaceId: string;
  title?: string;
  actions?: SurfaceAction[];
  display?: "inline" | "panel";
  /** The message ID that this surface belongs to (for history loading). */
  messageId?: string;
  /** When `true`, clicking an action does not dismiss the surface — the client keeps the card visible and only marks the clicked `actionId` as spent so siblings remain clickable. */
  persistent?: boolean;
  /** Id of the tool call that produced this surface (the `ui_show` proxy tool). Lets the client gate app previews on the tool result's arrival rather than whole-turn streaming state. */
  toolCallId?: string;
}

export interface UiSurfaceShowCard extends UiSurfaceShowBase {
  surfaceType: "card";
  data: CardSurfaceData;
}

export interface UiSurfaceShowChoice extends UiSurfaceShowBase {
  surfaceType: "choice";
  data: ChoiceSurfaceData;
}

export interface UiSurfaceShowCopyBlock extends UiSurfaceShowBase {
  surfaceType: "copy_block";
  data: CopyBlockSurfaceData;
}

export interface UiSurfaceShowOAuthConnect extends UiSurfaceShowBase {
  surfaceType: "oauth_connect";
  data: OAuthConnectSurfaceData;
}

export interface UiSurfaceShowForm extends UiSurfaceShowBase {
  surfaceType: "form";
  data: FormSurfaceData;
}

export interface UiSurfaceShowList extends UiSurfaceShowBase {
  surfaceType: "list";
  data: ListSurfaceData;
}

export interface UiSurfaceShowConfirmation extends UiSurfaceShowBase {
  surfaceType: "confirmation";
  data: ConfirmationSurfaceData;
}

export interface UiSurfaceShowDynamicPage extends UiSurfaceShowBase {
  surfaceType: "dynamic_page";
  data: DynamicPageSurfaceData;
}

export interface UiSurfaceShowTable extends UiSurfaceShowBase {
  surfaceType: "table";
  data: TableSurfaceData;
}

export interface UiSurfaceShowFileUpload extends UiSurfaceShowBase {
  surfaceType: "file_upload";
  data: FileUploadSurfaceData;
}

export interface UiSurfaceShowDocumentPreview extends UiSurfaceShowBase {
  surfaceType: "document_preview";
  data: DocumentPreviewSurfaceData;
}

export interface UiSurfaceShowSpreadsheetPreview extends UiSurfaceShowBase {
  surfaceType: "spreadsheet_preview";
  data: SpreadsheetPreviewSurfaceData;
}

export interface UiSurfaceShowWorkResult extends UiSurfaceShowBase {
  surfaceType: "work_result";
  data: WorkResultSurfaceData;
}

/**
 * Anything sendable, savable or schedulable. The client renders it as a card
 * with the verb on it rather than leaving prose to be copied out of a message.
 *
 * Deliberately NOT in {@link INTERACTIVE_SURFACE_TYPES}: an artefact must not
 * park the turn in `awaiting_user_input`. The conversation never blocks, and a
 * draft the owner has not looked at yet is not a question being asked of them.
 * Its consequential actions are gated by the execution layer when pressed, not
 * by holding the turn open.
 */
export interface UiSurfaceShowArtefact extends UiSurfaceShowBase {
  surfaceType: "artefact";
  data: Record<string, unknown>;
}

/**
 * At most one per turn, and only about something the turn actually touched.
 * Also non-interactive, for the same reason: an offer the owner ignores must
 * not leave the conversation waiting on them.
 */
export interface UiSurfaceShowAdjacentOffer extends UiSurfaceShowBase {
  surfaceType: "adjacent_offer";
  data: Record<string, unknown>;
}

export type UiSurfaceShow =
  | UiSurfaceShowCard
  | UiSurfaceShowChoice
  | UiSurfaceShowCopyBlock
  | UiSurfaceShowOAuthConnect
  | UiSurfaceShowForm
  | UiSurfaceShowList
  | UiSurfaceShowTable
  | UiSurfaceShowConfirmation
  | UiSurfaceShowDynamicPage
  | UiSurfaceShowFileUpload
  | UiSurfaceShowDocumentPreview
  | UiSurfaceShowSpreadsheetPreview
  | UiSurfaceShowWorkResult
  | UiSurfaceShowArtefact
  | UiSurfaceShowAdjacentOffer;

export interface UiSurfaceUpdate {
  type: "ui_surface_update";
  conversationId: string;
  surfaceId: string;
  data: Partial<SurfaceData>;
}

export interface UiSurfaceDismiss {
  type: "ui_surface_dismiss";
  conversationId: string;
  surfaceId: string;
}

export interface UiSurfaceComplete {
  type: "ui_surface_complete";
  conversationId: string;
  surfaceId: string;
  summary: string;
  submittedData?: Record<string, unknown>;
}

export interface UiSurfaceUndoResult {
  type: "ui_surface_undo_result";
  conversationId: string;
  surfaceId: string;
  success: boolean;
  /** Number of remaining undo entries after this undo. */
  remainingUndos: number;
}

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _SurfacesClientMessages = UiSurfaceAction | UiSurfaceUndoRequest;

export type _SurfacesServerMessages =
  | UiSurfaceShow
  | UiSurfaceUpdate
  | UiSurfaceDismiss
  | UiSurfaceComplete
  | UiSurfaceUndoResult;
