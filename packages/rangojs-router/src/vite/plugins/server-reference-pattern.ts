// plugin-rsc's rsc:use-server transform emits inline/exported server references
// as `registerServerReference(<value>, "<id>", "<name>")`, where <value> is a
// hoisted identifier (no top-level comma) and a trailing `.bind(null,
// encryptActionBoundArgs(...))` lies OUTSIDE the call. Two plugins parse this
// same shape -- expose-action-id ($id wrapping) and server-ref-hashing (id ->
// production hash) -- so the pattern has a single owner here. Returns a fresh
// /g RegExp per call to avoid sharing lastIndex state across callers.
export function registerServerReferenceRegex(): RegExp {
  return /registerServerReference\(([^,]+),\s*"([^"]+)",\s*"([^"]+)"\)/g;
}
