import { router } from "./router.js";

export default (request: Request, input: any) => router.fetch(request, input);
