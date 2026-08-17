import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { withSuppressedConfigDiskWritesSync } from "../config/loader.js";
import { getLogger } from "../util/logger.js";
import { ensureDataDir, getDbPath, getMemoryDbPath } from "../util/platform.js";
import { backfillAppConversationIds } from "./app-store.js";
import {
  getDb,
  getMemoryDb,
  getMemorySqlite,
  getSqlite,
} from "./db-connection.js";
import { migrateToolCreatedItems } from "./graph/bootstrap.js";
import {
  addCoreColumns,
  createActivationSessionsTable,
  createApprovalPromptTsTrackerTable,
  createAssistantInboxTables,
  createAuthFallbackEventsTable,
  createCallSessionsTables,
  createCanonicalGuardianTables,
  createChannelGuardianTables,
  createContactsAndTriageTables,
  createConversationAttentionTables,
  createCoreIndexes,
  createCoreTables,
  createExternalConversationBindingsTables,
  createFollowupsTables,
  createLifecycleEventsTable,
  createMediaAssetsTables,
  createMessagesFts,
  createNotificationTables,
  createOAuthTables,
  createOnboardingEventsTable,
  createScopedApprovalGrantsTable,
  createSequenceTables,
  createSkillLoadedEventsTable,
  createTasksAndWorkItemsTables,
  createWatchersAndLogsTables,
  migrate230AcpSessionHistory,
  migrate231RepairMemoryGraphEventDates,
  migrateA2ATasks,
  migrateAcpSessionHistoryCwd,
  migrateActivationState,
  migrateActivationStateFkCascade,
  migrateAddConversationInferenceProfile,
  migrateAddMemoryV3EverInjected,
  migrateAddMemoryV3Selections,
  migrateAddSourceTypeColumns,
  migrateAgentActsCostModelTitle,
  migrateAgentToolScopes,
  migrateArrivalComprehension,
  migrateArrivalOccurredAt,
  migrateArrivals,
  migrateAssistantContactMetadata,
  migrateAutomations,
  migrateAutonomyLedger,
  migrateBackfillAudioAttachmentMimeTypes,
  migrateBackfillContactInteractionStats,
  migrateBackfillGuardianPrincipalId,
  migrateBackfillInlineAttachmentsToDisk,
  migrateBackfillProviderConnectionLabel,
  migrateBackfillUsageCacheAccounting,
  migrateBudgetPolicies,
  migrateCallSessionInviteMetadata,
  migrateCallSessionMode,
  migrateCallSessionSkipDisclosure,
  migrateCanonicalGuardianDeliveriesDestinationIndex,
  migrateCanonicalGuardianRequesterChatId,
  migrateCapabilityCardColumns,
  migrateChannelInboundDeliveredSegments,
  migrateChannelInboundDeliveryAttempts,
  migrateChannelInteractionColumns,
  migrateContactChannelsAccessFields,
  migrateContactChannelsTypeChatIdIndex,
  migrateContactInteractionIndexes,
  migrateContactsAssistantId,
  migrateContactsNotesColumn,
  migrateContactsRolePrincipal,
  migrateContactsUserFileColumn,
  migrateConversationCleanedAt,
  migrateConversationForkLineage,
  migrateConversationHostAccess,
  migrateConversationInferenceProfileSession,
  migrateConversationLastNotifiedProfile,
  migrateConversationProcessingFlags,
  migrateConversationsArchivedAt,
  migrateConversationsLastMessageAt,
  migrateConversationsSurfacedAt,
  migrateConversationsThreadTypeIndex,
  migrateCreateAgentActs,
  migrateCreateAgents,
  migrateCreateBrandProfiles,
  migrateCreateContactMemory,
  migrateCreateConversationGraphMemoryState,
  migrateCreateDocumentComments,
  migrateCreateDocumentConversations,
  migrateCreateKits,
  migrateCreateMemoryGraphNodeEdits,
  migrateCreateMemoryGraphTables,
  migrateCreateMemoryRecallLogs,
  migrateCreateMissions,
  migrateCreateProjectKnowledge,
  migrateCreateProjectsTable,
  migrateCreateProviderConnections,
  migrateCreatePushDevices,
  migrateCreateThreadStartersTable,
  migrateCreateTraceEventsTable,
  migrateCreateWorkItemEvents,
  migrateCreateWorkOutputs,
  migrateDeletePrivateConversations,
  migrateDropAccountsTable,
  migrateDropAssistantIdColumns,
  migrateDropCallbackTransportColumn,
  migrateDropCapabilityCardState,
  migrateDropConflicts,
  migrateDropContactInteractionColumns,
  migrateDropEntityTables,
  migrateDropLegacyMemberGuardianTables,
  migrateDropLoopbackPortColumn,
  migrateDropMemoryItemsTables,
  migrateDropMemorySegmentFts,
  migrateDropOrphanedMediaTables,
  migrateDropProviderConnectionStatus,
  migrateDropRemindersTable,
  migrateDropSetupSkillIdColumn,
  migrateDropSimplifiedMemory,
  migrateDropUsageCompositeIndexes,
  migrateExternalConversationBindingChatName,
  migrateExternalConversationBindingThreadId,
  migrateFkCascadeRebuilds,
  migrateGuardianActionFollowup,
  migrateGuardianActionSupersession,
  migrateGuardianActionToolMetadata,
  migrateGuardianBootstrapToken,
  migrateGuardianDeliveryConversationIndex,
  migrateGuardianPrincipalIdColumns,
  migrateGuardianPrincipalIdNotNull,
  migrateGuardianRequestEnrichmentColumns,
  migrateGuardianTimestampsEpochMs,
  migrateGuardianVerificationPurpose,
  migrateGuardianVerificationSessions,
  migrateGuardrails,
  migrateHeartbeatRuns,
  migrateInviteCodeHashColumn,
  migrateInviteContactId,
  migrateLlmRequestLogAgentLoopExitReason,
  migrateLlmRequestLogCallSite,
  migrateLlmRequestLogMessageId,
  migrateLlmRequestLogProvider,
  migrateLlmRequestLogsCreatedAtIndex,
  migrateLlmUsageAddRawUsage,
  migrateLlmUsageAgentAttribution,
  migrateLlmUsageAttribution,
  migrateLlmUsageEventsAddAssistantVersion,
  migrateMemoryGraphImageRefs,
  migrateMemoryItemSupersession,
  migrateMemoryJobOutcome,
  migrateMemoryNodeInjectionEvents,
  migrateMemoryRecallLogsQueryContext,
  migrateMemoryRetrospectiveRememberedLog,
  migrateMemoryRetrospectiveState,
  migrateMemoryV2ActivationLogs,
  migrateMemoryV2InjectionEvents,
  migrateMemoryV3AutoEdges,
  migrateMemoryV3Coactivation,
  migrateMessageBookmarks,
  migrateMessagesClientMessageId,
  migrateMessagesConversationCreatedAtIndex,
  migrateMessagesFtsBackfill,
  migrateMessagesRoleCreatedAtIndex,
  migrateMissionSweepAt,
  migrateMoveConversationMemoryStateToMemoryDb,
  migrateMoveMemoryGraphClusterToMemoryDb,
  migrateMoveMemoryJobsToMemoryDb,
  migrateMoveMemoryTelemetryLogsToMemoryDb,
  migrateMoveMemoryV3TablesToMemoryDb,
  migrateNormalizePhoneIdentities,
  migrateNormalizeSlackExternalContent,
  migrateNormalizeUserFileByPrincipal,
  migrateNotificationDeliveryThreadDecision,
  migrateOAuthAppsClientSecretPath,
  migrateOAuthProvidersAvailableScopes,
  migrateOAuthProvidersBehaviorColumns,
  migrateOAuthProvidersDisplayMetadata,
  migrateOAuthProvidersFeatureFlag,
  migrateOAuthProvidersLogoUrl,
  migrateOAuthProvidersManagedServiceConfigKey,
  migrateOAuthProvidersManagedServiceIsPaid,
  migrateOAuthProvidersPingConfig,
  migrateOAuthProvidersPingUrl,
  migrateOAuthProvidersRefreshUrl,
  migrateOAuthProvidersRevoke,
  migrateOAuthProvidersScopeSeparator,
  migrateOAuthProvidersTokenAuthMethodDefault,
  migrateOAuthProvidersTokenExchangeBodyFormat,
  migrateOnboardingEventsFunnelColumns,
  migrateOnboardingEventsPriorAssistants,
  migrateProjectsCoworkColumns,
  migrateProviderConnectionBaseUrlAndModels,
  migrateProviderConnectionStatusLabel,
  migratePushBudgetLedger,
  migrateReconcileDuplicateGuardians,
  migrateReminderRoutingIntent,
  migrateRemindersToSchedules,
  migrateRenameCleanedAt,
  migrateRenameConversationTypeColumn,
  migrateRenameCreatedBySessionIdColumns,
  migrateRenameFollowupsThreadIdColumn,
  migrateRenameGmailProviderKeyToGoogle,
  migrateRenameGuardianVerificationValues,
  migrateRenameInboxThreadStateTable,
  migrateRenameInferenceProfileSnakeCase,
  migrateRenameMemoryGraphTypeValues,
  migrateRenameNotificationThreadColumns,
  migrateRenameSequenceEnrollmentsThreadIdColumn,
  migrateRenameSequenceStepsReplyKey,
  migrateRenameSourceSessionIdColumn,
  migrateRenameThreadStartersCheckpoints,
  migrateRenameThreadStartersTable,
  migrateRenameVerificationSessionIdColumn,
  migrateRenameVerificationTable,
  migrateRenameVoiceToPhone,
  migrateRitualSnapshots,
  migrateScheduleDescription,
  migrateScheduleInferenceProfile,
  migrateScheduleOneShotRouting,
  migrateScheduleQuietFlag,
  migrateScheduleRetryPolicy,
  migrateScheduleReuseConversation,
  migrateScheduleScriptColumn,
  migrateScheduleScriptTimeout,
  migrateScheduleSourceConversation,
  migrateScheduleWakeConversationId,
  migrateSchemaIndexesAndColumns,
  migrateScrubCorruptedImageAttachments,
  migrateSlackCompactionWatermark,
  migrateStandingRules,
  migrateStripBaseUrlNonOpenaiCompatible,
  migrateStripIntegrationPrefixFromProviderKeys,
  migrateStripPlaceholderSentinelsFromMessages,
  migrateStripThinkingFromConsolidated,
  migrateToolInvocationsCreatedAtIdIndex,
  migrateToolInvocationsMatchedRuleId,
  migrateToolInvocationsSkillId,
  migrateToolInvocationsTelemetryColumns,
  migrateTraceEventsCreatedAtIndex,
  migrateUsageDashboardIndexes,
  migrateUsageLlmCallCount,
  migrateVoiceInviteColumns,
  migrateVoiceInviteDisplayMetadata,
  migrateVolumeValve,
  migrateWorkItemAssessment,
  migrateWorkItemAutoRunEligibility,
  migrateWorkItemHygiene,
  migrateWorkItemLifeLensAndWaiting,
  migrateWorkItemLiveness,
  migrateWorkItemOriginConversation,
  migrateWorkItemPmColumns,
  migrateWorkItemProgressNote,
  migrateWorkItemsRunConversationIndex,
  recoverCrashedMigrations,
  runComplexMigrations,
  runLateMigrations,
  validateMigrationState,
} from "./migrations/index.js";
import { PLANNER_OPTIMIZE_PRAGMA } from "./planner-statistics.js";

// ---------------------------------------------------------------------------
// Test DB template — run migrations once, reuse across test files
// ---------------------------------------------------------------------------

function getTemplateDbPath(): string {
  // Hash this file + all migration files + bootstrap migration so the template
  // auto-invalidates when any migration changes.
  const thisFile = new URL(import.meta.url).pathname;
  const hash = createHash("md5");
  hash.update(readFileSync(thisFile, "utf-8"));
  const migrationsDir = join(dirname(thisFile), "migrations");
  for (const name of readdirSync(migrationsDir).sort()) {
    if (name.endsWith(".ts")) {
      hash.update(readFileSync(join(migrationsDir, name), "utf-8"));
    }
  }
  // Include the bootstrap migration (migrateToolCreatedItems) which also runs
  // during initializeDb but lives outside the migrations/ directory.
  const bootstrapFile = join(dirname(thisFile), "graph", "bootstrap.ts");
  if (existsSync(bootstrapFile)) {
    hash.update(readFileSync(bootstrapFile, "utf-8"));
  }
  return join(
    tmpdir(),
    `vellum-test-db-template-${hash.digest("hex").slice(0, 12)}.db`,
  );
}

/** Memory-DB counterpart of the test template (same invalidation hash). */
function getMemoryTemplateDbPath(): string {
  return getTemplateDbPath().replace(/\.db$/, "-memory.db");
}

function tryRestoreTemplate(): boolean {
  const templatePath = getTemplateDbPath();
  const memoryTemplatePath = getMemoryTemplateDbPath();
  // Both files or neither: a main template without its memory sibling
  // (e.g. saved by a pre-split build with the same hash — impossible in
  // practice since this file is part of the hash, but cheap to guard)
  // must fall through to a full migration run.
  if (!existsSync(templatePath) || !existsSync(memoryTemplatePath)) {
    return false;
  }
  // getDb() hasn't run yet, so the data directory may not exist.
  ensureDataDir();
  copyFileSync(templatePath, getDbPath());
  copyFileSync(memoryTemplatePath, getMemoryDbPath());
  // Open the pre-migrated copies — the getters set PRAGMAs but skip
  // migrations.
  getDb();
  getMemoryDb();
  return true;
}

function saveTemplate(): void {
  try {
    // Flush WALs to the DB files before copying. TRUNCATE is safe here:
    // these are the daemon-process's own long-lived connections during a
    // single-process test bootstrap (see assistant/CLAUDE.md).
    getSqlite().exec("PRAGMA wal_checkpoint(TRUNCATE)");
    getMemorySqlite().exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const tmpFile = `${getTemplateDbPath()}.${process.pid}`;
    const tmpMemoryFile = `${getMemoryTemplateDbPath()}.${process.pid}`;
    copyFileSync(getDbPath(), tmpFile);
    copyFileSync(getMemoryDbPath(), tmpMemoryFile);
    // Atomic renames — safe even with parallel test workers. Memory file
    // first so a main template is never visible without its sibling
    // (tryRestoreTemplate requires both).
    renameSync(tmpMemoryFile, getMemoryTemplateDbPath());
    renameSync(tmpFile, getTemplateDbPath());
  } catch {
    // Best effort — next file will just run migrations normally.
  }
}

// ---------------------------------------------------------------------------

export function initializeDb(): void {
  if (process.env.BUN_TEST === "1" && tryRestoreTemplate()) {
    return;
  }

  const log = getLogger("db-init");
  const database = getDb();

  // Every migration step, in execution order. Each function accepts a
  // DrizzleDb and is identified by its .name.
  const migrationSteps = [
    createCoreTables,
    recoverCrashedMigrations,
    createWatchersAndLogsTables,
    addCoreColumns,
    runComplexMigrations,
    createCoreIndexes,
    createContactsAndTriageTables,
    createCallSessionsTables,
    migrateCallSessionMode,
    createFollowupsTables,
    createTasksAndWorkItemsTables,
    createExternalConversationBindingsTables,
    createChannelGuardianTables,
    migrateGuardianVerificationSessions,
    migrateGuardianBootstrapToken,
    migrateGuardianVerificationPurpose,
    createMediaAssetsTables,
    createAssistantInboxTables,
    runLateMigrations,
    migrateChannelInboundDeliveredSegments,
    migrateGuardianActionFollowup,
    migrateGuardianActionToolMetadata,
    migrateGuardianActionSupersession,
    migrateConversationsThreadTypeIndex,
    migrateGuardianDeliveryConversationIndex,
    createNotificationTables,
    createSequenceTables,
    createMessagesFts,
    migrateMessagesFtsBackfill,
    createConversationAttentionTables,
    migrateReminderRoutingIntent,
    migrateSchemaIndexesAndColumns,
    migrateFkCascadeRebuilds,
    createScopedApprovalGrantsTable,
    migrateNotificationDeliveryThreadDecision,
    createCanonicalGuardianTables,
    migrateCanonicalGuardianRequesterChatId,
    migrateCanonicalGuardianDeliveriesDestinationIndex,
    migrateNormalizePhoneIdentities,
    migrateVoiceInviteColumns,
    migrateVoiceInviteDisplayMetadata,
    migrateInviteCodeHashColumn,
    createApprovalPromptTsTrackerTable,
    migrateGuardianPrincipalIdColumns,
    migrateBackfillGuardianPrincipalId,
    migrateGuardianPrincipalIdNotNull,
    migrateContactsRolePrincipal,
    migrateContactChannelsAccessFields,
    migrateContactChannelsTypeChatIdIndex,
    migrateDropLegacyMemberGuardianTables,
    migrateContactsAssistantId,
    migrateAssistantContactMetadata,
    migrateContactsNotesColumn,
    migrateBackfillContactInteractionStats,
    migrateDropAssistantIdColumns,
    migrateUsageDashboardIndexes,
    // 42. (skipped) migrateReorderUsageDashboardIndexes — superseded by 43
    migrateDropUsageCompositeIndexes,
    migrateBackfillUsageCacheAccounting,
    migrateRenameVerificationTable,
    migrateRenameVerificationSessionIdColumn,
    migrateRenameGuardianVerificationValues,
    migrateRenameVoiceToPhone,
    migrateDropAccountsTable,
    migrateScheduleOneShotRouting,
    migrateRemindersToSchedules,
    migrateDropRemindersTable,
    createOAuthTables,
    migrateOAuthAppsClientSecretPath,
    migrateOAuthProvidersPingUrl,
    migrateMemoryItemSupersession,
    migrateDropEntityTables,
    migrateDropMemorySegmentFts,
    migrateDropConflicts,
    migrateCallSessionInviteMetadata,
    migrateInviteContactId,
    migrateChannelInteractionColumns,
    migrateDropContactInteractionColumns,
    migrateDropLoopbackPortColumn,
    migrateDropOrphanedMediaTables,
    migrateGuardianTimestampsEpochMs,
    migrateRenameInboxThreadStateTable,
    migrateRenameConversationTypeColumn,
    migrateRenameNotificationThreadColumns,
    migrateRenameFollowupsThreadIdColumn,
    migrateRenameSequenceEnrollmentsThreadIdColumn,
    migrateRenameSequenceStepsReplyKey,
    migrateRenameGmailProviderKeyToGoogle,
    migrateCreateThreadStartersTable,
    migrateCapabilityCardColumns,
    migrateRenameCreatedBySessionIdColumns,
    migrateRenameSourceSessionIdColumn,
    migrateRenameThreadStartersTable,
    migrateRenameThreadStartersCheckpoints,
    createLifecycleEventsTable,
    migrateDropCapabilityCardState,
    migrateCreateTraceEventsTable,
    migrateOAuthProvidersManagedServiceConfigKey,
    migrateOAuthProvidersDisplayMetadata,
    migrateLlmRequestLogMessageId,
    migrateLlmRequestLogProvider,
    migrateBackfillInlineAttachmentsToDisk,
    migrateConversationForkLineage,
    migrateScheduleQuietFlag,
    migrateDropSimplifiedMemory,
    migrateCallSessionSkipDisclosure,
    migrateBackfillAudioAttachmentMimeTypes,
    migrateContactsUserFileColumn,
    migrateAddSourceTypeColumns,
    migrateCreateMemoryRecallLogs,
    migrateOAuthProvidersPingConfig,
    migrateStripIntegrationPrefixFromProviderKeys,
    migrateMessagesConversationCreatedAtIndex,
    migrateOAuthProvidersBehaviorColumns,
    migrateDropSetupSkillIdColumn,
    migrateGuardianRequestEnrichmentColumns,
    migrateUsageLlmCallCount,
    migrateOAuthProvidersFeatureFlag,
    migrateDropCallbackTransportColumn,
    migrateCreateMemoryGraphTables,
    // 101a. Add nullable image_refs column — must run before migrateToolCreatedItems
    // which inserts rows into memory_graph_nodes including the image_refs column.
    migrateMemoryGraphImageRefs,
    // 101b. Migrate tool-created items from legacy memory_items → graph nodes.
    // Must run before migrateDropMemoryItemsTables so data is preserved.
    function migrateToolCreatedItemsStep() {
      migrateToolCreatedItems();
    },
    migrateDropMemoryItemsTables,
    migrateRenameMemoryGraphTypeValues,
    migrateCreateMemoryGraphNodeEdits,
    migrateScrubCorruptedImageAttachments,
    migrateCreateConversationGraphMemoryState,
    migrateConversationsLastMessageAt,
    migrateStripThinkingFromConsolidated,
    migrateScheduleReuseConversation,
    migrateScheduleScriptColumn,
    migrateMemoryRecallLogsQueryContext,
    migrateLlmRequestLogsCreatedAtIndex,
    migrateOAuthProvidersScopeSeparator,
    migrateOAuthProvidersRefreshUrl,
    migrateOAuthProvidersRevoke,
    migrateOAuthProvidersTokenAuthMethodDefault,
    migrateConversationHostAccess,
    migrateOAuthProvidersLogoUrl,
    migrateOAuthProvidersTokenExchangeBodyFormat,
    migrateNormalizeUserFileByPrincipal,
    migrateConversationsArchivedAt,
    migrateStripPlaceholderSentinelsFromMessages,
    migrateOAuthProvidersManagedServiceIsPaid,
    migrateOAuthProvidersAvailableScopes,
    migrateScheduleWakeConversationId,
    migrateAddConversationInferenceProfile,
    migrateRenameInferenceProfileSnakeCase,
    migrateDeletePrivateConversations,
    migrate230AcpSessionHistory,
    migrate231RepairMemoryGraphEventDates,
    migrateActivationState,
    migrateActivationStateFkCascade,
    migrateMemoryV2ActivationLogs,
    migrateCreateDocumentConversations,
    migrateLlmUsageAttribution,
    migrateSlackCompactionWatermark,
    migrateToolInvocationsMatchedRuleId,
    migrateHeartbeatRuns,
    function migrateBackfillAppConversationIds() {
      backfillAppConversationIds();
    },
    migrateScheduleRetryPolicy,
    migrateTraceEventsCreatedAtIndex,
    migrateConversationInferenceProfileSession,
    migrateMessageBookmarks,
    migrateCreateProviderConnections,
    migrateProviderConnectionStatusLabel,
    migrateMemoryRetrospectiveState,
    migrateBackfillProviderConnectionLabel,
    migrateExternalConversationBindingThreadId,
    createOnboardingEventsTable,
    migrateNormalizeSlackExternalContent,
    migrateProviderConnectionBaseUrlAndModels,
    migrateA2ATasks,
    migrateLlmRequestLogAgentLoopExitReason,
    migrateCreateDocumentComments,
    migrateExternalConversationBindingChatName,
    migrateChannelInboundDeliveryAttempts,
    migrateMemoryV2InjectionEvents,
    migrateConversationLastNotifiedProfile,
    migrateStripBaseUrlNonOpenaiCompatible,
    migrateOnboardingEventsPriorAssistants,
    migrateConversationCleanedAt,
    migrateRenameCleanedAt,
    migrateLlmUsageAddRawUsage,
    migrateMemoryV3Coactivation,
    migrateMemoryV3AutoEdges,
    migrateLlmRequestLogCallSite,
    migrateDropProviderConnectionStatus,
    migrateMessagesClientMessageId,
    migrateLlmUsageEventsAddAssistantVersion,
    migrateAddMemoryV3Selections,
    migrateScheduleScriptTimeout,
    migrateScheduleDescription,
    migrateScheduleSourceConversation,
    migrateMessagesRoleCreatedAtIndex,
    createAuthFallbackEventsTable,
    migrateAcpSessionHistoryCwd,
    migrateOnboardingEventsFunnelColumns,
    createActivationSessionsTable,
    migrateToolInvocationsSkillId,
    migrateToolInvocationsCreatedAtIdIndex,
    migrateAddMemoryV3EverInjected,
    migrateToolInvocationsTelemetryColumns,
    createSkillLoadedEventsTable,
    migrateConversationsSurfacedAt,
    migrateMemoryRetrospectiveRememberedLog,
    migrateScheduleInferenceProfile,
    migrateReconcileDuplicateGuardians,
    migrateCreateProjectsTable,
    migrateWorkItemPmColumns,
    migrateCreateWorkItemEvents,
    migrateCreatePushDevices,
    migrateProjectsCoworkColumns,
    migrateWorkItemProgressNote,
    migrateCreateProjectKnowledge,
    migrateCreateMissions,
    migrateCreateWorkOutputs,
    migrateCreateAgentActs,
    migrateCreateContactMemory,
    migrateContactInteractionIndexes,
    migrateCreateAgents,
    migrateCreateBrandProfiles,
    migrateCreateKits,
    migrateGuardrails,
    migrateAgentActsCostModelTitle,
    migrateAgentToolScopes,
    migrateBudgetPolicies,
    migrateWorkItemLiveness,
    migrateStandingRules,
    migrateWorkItemAutoRunEligibility,
    migrateWorkItemsRunConversationIndex,
    migrateWorkItemHygiene,
    migrateLlmUsageAgentAttribution,
    migrateMissionSweepAt,
    migrateConversationProcessingFlags,
    migrateAutomations,
    migrateWorkItemAssessment,
    migrateWorkItemOriginConversation,
    migrateAutonomyLedger,
    migrateWorkItemLifeLensAndWaiting,
    migrateArrivals,
    migrateArrivalComprehension,
    migrateArrivalOccurredAt,
    migratePushBudgetLedger,
    migrateMemoryJobOutcome,
    migrateVolumeValve,
    migrateRitualSnapshots,
    // 324–328: the memory-DB split. These run every boot AFTER every
    // creator/ALTER migration above (the legacy `CREATE TABLE IF NOT
    // EXISTS` creators recreate empty main-side shadows each boot; the
    // relocation steps drop them again). Order within the block matters
    // only for readability — each step owns a disjoint table set.
    migrateMoveConversationMemoryStateToMemoryDb,
    migrateMoveMemoryGraphClusterToMemoryDb,
    migrateMoveMemoryTelemetryLogsToMemoryDb,
    migrateMoveMemoryV3TablesToMemoryDb,
    migrateMoveMemoryJobsToMemoryDb,
    // 329 creates a NEW memory-DB table (no main-side original), so it runs
    // after the relocation block rather than inside it.
    migrateMemoryNodeInjectionEvents,
  ];

  // Run each migration step, catching and logging individual failures so one
  // broken migration doesn't prevent independent later ones from succeeding.
  //
  // Config disk writes are suppressed for the whole pass: DB migrations run
  // before workspace migrations (see daemon/lifecycle.ts ordering), and a
  // migration that reads config on a fresh workspace would otherwise trigger
  // the first-launch write that persists every schema default — defeating any
  // later workspace migration whose idempotency guard is "key already present
  // in config" (migration 140 reads llm.pricingOverrides and hit exactly
  // this). Migrations may read config; they must not cause it to be written.
  const failures: string[] = [];
  withSuppressedConfigDiskWritesSync(() => {
    for (const step of migrationSteps) {
      try {
        log.debug({ migration: step.name }, `Starting migration: ${step.name}`);
        step(database);
        log.debug(
          { migration: step.name },
          `Migration succeeded: ${step.name}`,
        );
      } catch (err) {
        failures.push(step.name);
        log.error(
          { err, migration: step.name },
          `Migration failed: ${step.name}`,
        );
      }
    }
  });

  if (failures.length > 0) {
    log.error(
      { failedMigrations: failures, count: failures.length },
      `DB initialization completed with ${failures.length} failed migration(s)`,
    );
  }

  // An index a migration creates has no sqlite_stat1 entry until something
  // analyzes it, which SQLite calls out as a case to handle after a schema
  // change. The steps above carry no applied/skipped signal, so this runs
  // every boot; the mask's analysis_limit keeps it bounded either way.
  try {
    getSqlite().exec(PLANNER_OPTIMIZE_PRAGMA);
  } catch (err) {
    log.warn({ err }, "Post-migration PRAGMA optimize failed (non-fatal)");
  }

  try {
    validateMigrationState(database);
  } catch (err) {
    log.error({ err }, "validateMigrationState failed");
  }

  if (process.env.BUN_TEST === "1") {
    saveTemplate();
  }
}
