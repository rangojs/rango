import { Outlet, Link } from "@rangojs/router/client";
import { BreadcrumbNav } from "./BreadcrumbNav.jsx";

// Server component that renders the client Link/Outlet primitives plus the
// client BreadcrumbNav. Wraps every route.
export function AppLayout() {
  return (
    <div data-testid="app-root">
      <header data-testid="header">
        <h1>No-TypeScript App</h1>
        <nav data-testid="main-nav">
          <Link to="/" data-testid="nav-home">
            Home
          </Link>
          {" | "}
          <Link to="/about" data-testid="nav-about">
            About
          </Link>
          {" | "}
          <Link to="/counter" data-testid="nav-counter">
            Counter
          </Link>
          {" | "}
          <Link to="/dashboard" data-testid="nav-dashboard">
            Dashboard
          </Link>
          {" | "}
          <Link to="/fetch" data-testid="nav-fetch">
            Fetch
          </Link>
          {" | "}
          <Link to="/flash" data-testid="nav-flash">
            Flash
          </Link>
          {" | "}
          <Link to="/blog" data-testid="nav-blog">
            Blog
          </Link>
        </nav>
        <BreadcrumbNav />
      </header>
      <main data-testid="main-content">
        <Outlet />
      </main>
      <footer data-testid="footer">
        <p>Plain JavaScript - verifying @rangojs/router without TypeScript</p>
      </footer>
    </div>
  );
}
