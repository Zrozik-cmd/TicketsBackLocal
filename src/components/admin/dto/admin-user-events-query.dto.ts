import { AdminEventsQueryDto } from "./admin-events-query.dto";

/** Query for GET /admin/users/:id/events — same filters as admin events list; organizer id is the path `:id`. */
export class AdminUserEventsQueryDto extends AdminEventsQueryDto {}
