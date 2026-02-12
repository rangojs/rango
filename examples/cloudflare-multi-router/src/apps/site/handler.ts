import { router } from "./router.js";

export default (request: Request, env: any) => router.fetch(request, env);
