/**
 * The full work-item record a project board renders — the exact shape the
 * daemon returns from `GET /projects/:id/work-items`. Shared by the board and
 * the task drawer so both read the same fields (context, sourceContext,
 * lastActivityAt, run linkage) without re-narrowing.
 */

import type { ProjectsByIdWorkitemsGetResponses } from "@/generated/daemon/types.gen";

export type BoardItem = ProjectsByIdWorkitemsGetResponses[200]["items"][number];
