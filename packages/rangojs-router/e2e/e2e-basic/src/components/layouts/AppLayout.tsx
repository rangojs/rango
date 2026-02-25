import { Outlet, Link } from "@rangojs/router/client";

export function AppLayout() {
  return (
    <div data-testid="app-root">
      <header data-testid="header">
        <h1>E2E Basic App</h1>
        <nav data-testid="main-nav">
          <Link to="/" data-testid="nav-home">
            Home
          </Link>
          {" | "}
          <Link to="/about" data-testid="nav-about">
            About
          </Link>
          {" | "}
          <Link to="/blog" data-testid="nav-blog">
            Blog
          </Link>
          {" | "}
          <Link to="/shop" data-testid="nav-shop">
            Shop
          </Link>
        </nav>
      </header>
      <main data-testid="main-content">
        <Outlet />
      </main>
      <footer data-testid="footer">
        <p>E2E Basic - Testing @rangojs/router</p>
      </footer>
    </div>
  );
}
