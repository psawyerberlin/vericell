import { NotFoundError } from "../errors.js";
import { getProjectDetail, listProjects } from "../queries.js";
import { ProjectsQuery, UnidParams } from "../schemas.js";
import type { TypedApp } from "../build.js";

export function registerProjectRoutes(app: TypedApp): void {
  app.get(
    "/api/v1/projects",
    {
      schema: {
        tags: ["projects"],
        summary: "Search anchored projects",
        querystring: ProjectsQuery,
      },
    },
    async (req) => {
      const { q, hash, address, active, page, limit } = req.query;
      const { rows, total } = listProjects(app.db, {
        q,
        hash,
        address,
        active: active === undefined ? undefined : active === "true",
        page,
        limit,
      });
      return {
        data: rows,
        page,
        limit,
        total,
        total_pages: Math.max(1, Math.ceil(total / limit)),
      };
    },
  );

  app.get(
    "/api/v1/projects/:unid",
    {
      schema: {
        tags: ["projects"],
        summary: "Project record, current live version, and full version chain",
        params: UnidParams,
      },
    },
    async (req) => {
      const detail = getProjectDetail(app.db, req.params.unid);
      if (!detail) throw new NotFoundError(`No project with unid "${req.params.unid}"`);
      return detail;
    },
  );
}
