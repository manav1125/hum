// Work item (task queue) types.

// === Client → Server ===

export interface WorkItemsListRequest {
  type: "work_items_list";
  status?: string; // optional filter
}

export interface WorkItemGetRequest {
  type: "work_item_get";
  id: string;
}

export interface WorkItemUpdateRequest {
  type: "work_item_update";
  id: string;
  title?: string;
  notes?: string;
  status?: string;
  priorityTier?: number;
  sortIndex?: number;
}

export interface WorkItemCompleteRequest {
  type: "work_item_complete";
  id: string;
}

export interface WorkItemDeleteRequest {
  type: "work_item_delete";
  id: string;
}

export interface WorkItemRunTaskRequest {
  type: "work_item_run_task";
  id: string;
}

export interface WorkItemOutputRequest {
  type: "work_item_output";
  id: string;
}

export interface WorkItemPreflightRequest {
  type: "work_item_preflight";
  id: string; // work item ID
}

export interface WorkItemApprovePermissionsRequest {
  type: "work_item_approve_permissions";
  id: string;
  approvedTools: string[]; // tools the user approved
}

export interface WorkItemCancelRequest {
  type: "work_item_cancel";
  id: string;
}

// === Server → Client ===

export interface WorkItemsListResponse {
  type: "work_items_list_response";
  items: Array<{
    id: string;
    taskId: string;
    title: string;
    notes: string | null;
    status: string;
    priorityTier: number;
    sortIndex: number | null;
    lastRunId: string | null;
    lastRunConversationId: string | null;
    lastRunStatus: string | null;
    sourceType: string | null;
    sourceId: string | null;
    createdAt: number;
    updatedAt: number;
  }>;
}

export interface WorkItemGetResponse {
  type: "work_item_get_response";
  item: {
    id: string;
    taskId: string;
    title: string;
    notes: string | null;
    status: string;
    priorityTier: number;
    sortIndex: number | null;
    lastRunId: string | null;
    lastRunConversationId: string | null;
    lastRunStatus: string | null;
    sourceType: string | null;
    sourceId: string | null;
    createdAt: number;
    updatedAt: number;
  } | null;
}

export interface WorkItemUpdateResponse {
  type: "work_item_update_response";
  item: {
    id: string;
    taskId: string;
    title: string;
    notes: string | null;
    status: string;
    priorityTier: number;
    sortIndex: number | null;
    lastRunId: string | null;
    lastRunConversationId: string | null;
    lastRunStatus: string | null;
    sourceType: string | null;
    sourceId: string | null;
    createdAt: number;
    updatedAt: number;
  } | null;
}

export interface WorkItemDeleteResponse {
  type: "work_item_delete_response";
  id: string;
  success: boolean;
}

export type WorkItemRunTaskErrorCode =
  | "not_found"
  | "already_running"
  | "invalid_status"
  | "no_task"
  | "permission_required";

export interface WorkItemRunTaskResponse {
  type: "work_item_run_task_response";
  id: string;
  lastRunId: string;
  success: boolean;
  error?: string;
  /** Structured error code so the client can deterministically re-enable buttons or show contextual UI. */
  errorCode?: WorkItemRunTaskErrorCode;
}

export interface WorkItemOutputResponse {
  type: "work_item_output_response";
  id: string;
  success: boolean;
  error?: string;
  output?: {
    title: string;
    status: string;
    runId: string | null;
    conversationId: string | null;
    completedAt: number | null;
    summary: string;
    highlights: string[];
  };
}

export interface WorkItemPreflightResponse {
  type: "work_item_preflight_response";
  id: string;
  success: boolean;
  error?: string;
  permissions?: {
    tool: string;
    description: string;
    riskLevel: "low" | "medium" | "high";
    currentDecision: "allow" | "deny" | "prompt";
  }[];
}

export interface WorkItemApprovePermissionsResponse {
  type: "work_item_approve_permissions_response";
  id: string;
  success: boolean;
  error?: string;
}

export interface WorkItemCancelResponse {
  type: "work_item_cancel_response";
  id: string;
  success: boolean;
  error?: string;
}

/** Server push — lightweight invalidation signal: the task queue has been mutated, refetch your list. */
export interface TasksChanged {
  type: "tasks_changed";
}

/** Server push — broadcast when a work item status changes (e.g. running -> awaiting_review). */
export interface WorkItemStatusChanged {
  type: "work_item_status_changed";
  item: {
    id: string;
    taskId: string;
    title: string;
    status: string;
    lastRunId: string | null;
    lastRunConversationId: string | null;
    lastRunStatus: string | null;
    /**
     * Live activity line ("Searching the web…") the runner stamps while the
     * item is running; null otherwise. Optional — older daemons omit it.
     */
    lastProgressNote?: string | null;
    updatedAt: number;
  };
}

/**
 * Server push — broadcast when the pre-run assessment produces a verdict for a
 * work item (work-items/work-item-assessment.ts). Emitted BEFORE the execution
 * turn starts, so a client can show what Cue understood and what it plans to
 * do as the run begins — or, for a non-`execute` verdict, show the question /
 * missing thing on an item that deliberately did not run.
 *
 * The same values are persisted on the work item (`assessment*` fields on the
 * work-item wire shape), so a client that missed the push reads them from the
 * item; this event exists so live surfaces don't have to poll.
 */
export interface WorkItemAssessed {
  type: "work_item_assessed";
  workItemId: string;
  /**
   * - `execute`     — Cue understands it and has what it needs; `plan` is set.
   * - `clarify`     — under-specified; `question` carries the ONE thing to ask.
   * - `not_ai_task` — a human action; surfaces should not offer a Run button.
   * - `blocked`     — `missing` names the one thing Cue lacks.
   */
  verdict: "execute" | "clarify" | "not_ai_task" | "blocked";
  /** One plain sentence: what Cue understood the task to be. */
  understanding: string | null;
  /** 1–2 plain-words lines of what Cue will do. Set with `execute`. */
  plan: string | null;
  /** Exactly one question. Set with `clarify`. */
  question: string | null;
  /** The one specific missing thing. Set with `blocked`. */
  missing: string | null;
  /** The assessor's 0–1 confidence. */
  confidence: number;
  /** Ready-to-render human line combining the fields above. */
  narration: string;
  /** ISO-8601 timestamp of the verdict. */
  assessedAt: string;
}

/** Server push — broadcast when a task run creates a conversation. */
export interface TaskRunConversationCreated {
  type: "task_run_conversation_created";
  conversationId: string;
  workItemId: string;
  title: string;
}

/**
 * Server push — broadcast when a background work item reaches a terminal
 * state, carrying the run's result inline so the UI does not have to poll
 * `getWorkItemOutput()` to learn what happened. Paired with (and emitted
 * after) the terminal `work_item_status_changed` for the same item.
 */
export interface WorkItemCompleted {
  type: "work_item_completed";
  workItemId: string;
  status: "done" | "awaiting_review" | "failed";
  result: {
    summary: string;
    highlights: string[];
    conversationId?: string;
  };
  /** ISO-8601 completion timestamp. */
  completedAt: string;
}

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _WorkItemsClientMessages =
  | WorkItemsListRequest
  | WorkItemGetRequest
  | WorkItemUpdateRequest
  | WorkItemCompleteRequest
  | WorkItemDeleteRequest
  | WorkItemRunTaskRequest
  | WorkItemOutputRequest
  | WorkItemPreflightRequest
  | WorkItemApprovePermissionsRequest
  | WorkItemCancelRequest;

export type _WorkItemsServerMessages =
  | WorkItemsListResponse
  | WorkItemGetResponse
  | WorkItemUpdateResponse
  | WorkItemDeleteResponse
  | WorkItemRunTaskResponse
  | WorkItemOutputResponse
  | WorkItemPreflightResponse
  | WorkItemApprovePermissionsResponse
  | WorkItemCancelResponse
  | WorkItemStatusChanged
  | WorkItemAssessed
  | WorkItemCompleted
  | TaskRunConversationCreated
  | TasksChanged;
