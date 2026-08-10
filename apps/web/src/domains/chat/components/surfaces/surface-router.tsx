import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import { INHERENTLY_INTERACTIVE_SURFACE_TYPES } from "@/domains/chat/types/types";
import type { Surface } from "@/domains/chat/types/types";
import { decisionStatusPresentation } from "@/domains/chat/utils/decision-status";

import { AdjacentOfferRow } from "@/domains/chat/partner/adjacent-offer-row";
import { ArtefactCard } from "@/domains/chat/partner/artefact-card";
import { BrowserViewSurface } from "@/domains/chat/components/surfaces/browser-view-surface";
import { CallSummarySurface } from "@/domains/chat/components/surfaces/call-summary-surface";
import { CardSurface } from "@/domains/chat/components/surfaces/card-surface";
import { ChoiceSurface } from "@/domains/chat/components/surfaces/choice-surface";
import { ConfirmationSurface } from "@/domains/chat/components/surfaces/confirmation-surface";
import { ConnectorRecommendSurface } from "@/domains/chat/components/surfaces/connector-recommend-surface";
import { CopyBlockSurface } from "@/domains/chat/components/surfaces/copy-block-surface";
import { DocumentPreviewSurface } from "@/domains/chat/components/surfaces/document-preview-surface";
import { DynamicPageSurface } from "@/domains/chat/components/surfaces/dynamic-page-surface";
import { ExternalAppSurface } from "@/domains/chat/components/surfaces/external-app-surface";
import { FileUploadSurface } from "@/domains/chat/components/surfaces/file-upload-surface";
import { FormSurface } from "@/domains/chat/components/surfaces/form-surface";
import { ListSurface } from "@/domains/chat/components/surfaces/list-surface";
import { OAuthConnectSurface } from "@/domains/chat/components/surfaces/oauth-connect-surface";
import { SpreadsheetPreviewSurface } from "@/domains/chat/components/surfaces/spreadsheet-preview-surface";
import { SurfaceContainer } from "@/domains/chat/components/surfaces/surface-container";
import { TableSurface } from "@/domains/chat/components/surfaces/table-surface";
import { TaskPreferencesSurface } from "@/domains/chat/components/surfaces/task-preferences-surface";
import { WorkResultSurface } from "@/domains/chat/components/surfaces/work-result-surface";

export interface SurfaceRouterProps {
  surface: Surface;
  onAction: (
    surfaceId: string,
    actionId: string,
    data?: Record<string, unknown>,
  ) => void | Promise<void>;
  assistantId?: string | null;
  assistantDisplayName?: string | null;
  onOpenApp?: (appId: string) => void;
  onOpenDocument?: (documentSurfaceId: string) => void;
  onOpenSpreadsheet?: (attachmentId: string, filename: string) => void;
  /** Tool calls of the message this surface belongs to. Threaded to
   *  `DynamicPageSurface`, which derives whether the surface's originating
   *  tool call has completed before unlocking the app preview. */
  toolCalls?: ChatMessageToolCall[];
}

export function SurfaceRouter({
  surface,
  onAction,
  assistantId,
  assistantDisplayName,
  onOpenApp,
  onOpenDocument,
  onOpenSpreadsheet,
  toolCalls,
}: SurfaceRouterProps) {
  if (
    surface.completed &&
    INHERENTLY_INTERACTIVE_SURFACE_TYPES.includes(surface.surfaceType)
  ) {
    // Decided-state pill (design ruling 5): shared wording from the
    // completion summary, in-app glyph + tint per state (Approved ✓ green ·
    // Denied ✕ red · Expired ◷ grey · Cancelled ✕ grey). Summaries without
    // a decision word keep the green done treatment.
    const { Icon, textClass, borderClass, bgClass } =
      decisionStatusPresentation(surface.completionSummary);
    return (
      <div
        className={`flex items-center gap-2 rounded-lg border ${borderClass} ${bgClass} px-3 py-2 text-body-medium-lighter ${textClass}`}
      >
        <Icon className="h-4 w-4 shrink-0" />
        {surface.completionSummary ?? surface.title ?? "Done"}
      </div>
    );
  }

  switch (surface.surfaceType) {
    case "form":
      return <FormSurface surface={surface} onAction={onAction} />;

    case "confirmation":
      return <ConfirmationSurface surface={surface} onAction={onAction} />;

    case "file_upload":
      return <FileUploadSurface surface={surface} onAction={onAction} />;

    case "card":
      return <CardSurface surface={surface} onAction={onAction} />;

    case "choice":
      return <ChoiceSurface surface={surface} onAction={onAction} />;

    case "copy_block":
      return <CopyBlockSurface surface={surface} onAction={onAction} />;

    case "oauth_connect":
      return (
        <OAuthConnectSurface
          surface={surface}
          onAction={onAction}
          assistantId={assistantId}
          assistantDisplayName={assistantDisplayName}
        />
      );

    case "connector_recommend":
      return (
        <ConnectorRecommendSurface
          surface={surface}
          onAction={onAction}
          assistantId={assistantId}
        />
      );

    case "list":
      return <ListSurface surface={surface} onAction={onAction} />;

    case "table":
      return <TableSurface surface={surface} onAction={onAction} />;

    case "dynamic_page":
      return (
        <DynamicPageSurface
          surface={surface}
          onAction={onAction}
          assistantId={assistantId}
          onOpenApp={onOpenApp}
          toolCalls={toolCalls}
        />
      );

    case "call_summary":
      return <CallSummarySurface surface={surface} onAction={onAction} />;

    case "browser_view":
      return <BrowserViewSurface surface={surface} onAction={onAction} />;

    case "task_preferences":
      return <TaskPreferencesSurface surface={surface} onAction={onAction} />;

    case "work_result":
      return <WorkResultSurface surface={surface} onAction={onAction} />;

    // The deliverable itself, with its verb on it. Its Send/Publish/Pay button
    // posts a surface action; the act still runs through the daemon's hard
    // checkpoint (`assistant/src/tools/outbound-send.ts`) — see
    // `partner/artefact-card.tsx`.
    case "artefact":
      return <ArtefactCard surface={surface} onAction={onAction} />;

    // The one adjacent thing Cue noticed. Capped to one per turn upstream in
    // `TranscriptMessageBody`; never blocks the turn.
    case "adjacent_offer":
      return <AdjacentOfferRow surface={surface} onAction={onAction} />;

    // "This looks like a job for <app>" — opens the embedded VentureVerse app
    // in Cue. Display-only; navigates rather than posting a surface action.
    case "external_app":
      return <ExternalAppSurface surface={surface} />;

    case "document_preview":
      return (
        <DocumentPreviewSurface
          surface={surface}
          onAction={onAction}
          onOpenDocument={onOpenDocument}
        />
      );

    case "spreadsheet_preview":
      return (
        <SpreadsheetPreviewSurface
          surface={surface}
          onAction={onAction}
          onOpenSpreadsheet={onOpenSpreadsheet}
        />
      );

    default:
      // Fallback card for unsupported surface types
      return (
        <SurfaceContainer surface={surface} onAction={onAction}>
          <p className="text-body-medium-lighter text-[var(--content-quiet)]">
            {surface.surfaceType
              ? `Unsupported surface type: ${surface.surfaceType}`
              : "Unknown surface"}
          </p>
        </SurfaceContainer>
      );
  }
}
