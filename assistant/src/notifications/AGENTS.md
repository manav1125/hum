# Notification Pipeline

All notification producers **MUST** go through `emitNotificationSignal()` in `notifications/emit-signal.ts`. Do not bypass the pipeline by broadcasting events directly -- the pipeline handles event persistence, deduplication, decision routing, and delivery audit.

When a notification flow creates a server-side conversation (e.g. guardian question conversations, task run conversations), the conversation and initial message **MUST** be persisted before the conversation-created event is emitted. This ensures the macOS/iOS client can immediately fetch the conversation contents when it receives the event.

Every remote (APNs) push **MUST** go through `sendBudgetedAlert()` in `notifications/push-dispatch.ts`. It applies design's three tiers and the three-a-day ceiling and writes the ledger row; `sendAlertToAllDevices()` is the raw transport underneath it and counts nothing. A push that reaches the transport directly is a push nobody counted — `__tests__/push-budget-chokepoint.test.ts` fails the build if one appears.

The same rule is implemented a second time in the web client (`apps/web/src/mobile-v3/states/push-budget.ts`) for local notifications, which cannot see remote push. The two are held in agreement by `__tests__/push-budget-client-parity.test.ts`; change the ceiling or the tier vocabulary on one side and it goes red.
