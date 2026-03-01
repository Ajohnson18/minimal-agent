import { db } from "../../db/client.js";
import { kaiDashboardArtifacts } from "../../db/schema/dashboard-artifacts.js";
import { eq, desc } from "drizzle-orm";
import { createError, ErrorCodes, type RpcError } from "../protocol/types.js";
import type {
  MetricsListParams,
  MetricsListResult,
  MetricsDeleteParams,
  MetricsDeleteResult,
} from "../protocol/methods.js";

export async function metricsList(
  params: MetricsListParams,
  _authUserId?: string,
): Promise<MetricsListResult | RpcError> {
  try {
    let query = db
      .select()
      .from(kaiDashboardArtifacts)
      .orderBy(desc(kaiDashboardArtifacts.updatedAt));

    if (params.powerId) {
      query = query.where(eq(kaiDashboardArtifacts.powerId, params.powerId)) as typeof query;
    }

    const rows = await query;
    return {
      metrics: rows.map((r) => ({
        id: r.id,
        powerId: r.powerId,
        powerName: r.powerName,
        key: r.key,
        label: r.label,
        artifactType: r.artifactType,
        data: r.data,
        icon: r.icon,
        lastRunId: r.lastRunId,
        updatedAt: r.updatedAt.getTime(),
        createdAt: r.createdAt.getTime(),
      })),
    };
  } catch {
    return createError(ErrorCodes.INTERNAL_ERROR, "Failed to list artifacts");
  }
}

export async function metricsDelete(
  params: MetricsDeleteParams,
  _authUserId?: string,
): Promise<MetricsDeleteResult | RpcError> {
  if (!params.id) {
    return createError(ErrorCodes.INVALID_PARAMS, "id is required");
  }
  try {
    await db.delete(kaiDashboardArtifacts).where(eq(kaiDashboardArtifacts.id, params.id));
    return { deleted: true };
  } catch {
    return createError(ErrorCodes.INTERNAL_ERROR, "Failed to delete artifact");
  }
}
