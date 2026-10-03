export function tagResponse(response: Response): Response {
  response.headers.set("x-app", "b v1");
  return response;
}
