interface InterceptConditionParams {
  from: { pathname: string };
}

// Intercept author page when navigating from blog index or author pages.
// Do NOT intercept from individual post pages (/blog/:slug).
export function shouldInterceptBlogAuthor({
  from,
}: InterceptConditionParams): boolean {
  const path = from.pathname;
  // Blog index
  if (path === "/blog" || path === "/blog/") {
    return true;
  }
  // Already on an author page
  if (path.startsWith("/blog/author/")) {
    return true;
  }
  // Any other /blog/* path is a post page -- navigate directly
  return false;
}
