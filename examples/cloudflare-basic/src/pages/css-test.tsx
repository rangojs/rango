import { Link } from "@rangojs/router/client";
import { PanelA } from "../components/css-test/PanelA.js";
import { PanelB } from "../components/css-test/PanelB.js";
import { PanelC } from "../components/css-test/PanelC.js";
import { PanelD } from "../components/css-test/PanelD.js";

function CssTestNav() {
  return (
    <nav data-testid="css-test-nav">
      <Link to="/css-test/a" data-testid="css-nav-a">A</Link>{" "}
      <Link to="/css-test/b" data-testid="css-nav-b">B</Link>{" "}
      <Link to="/css-test/c" data-testid="css-nav-c">C</Link>{" "}
      <Link to="/css-test/d" data-testid="css-nav-d">D</Link>{" "}
      <Link to="/css-test/all" data-testid="css-nav-all">All</Link>
    </nav>
  );
}

export function CssTestPanelAPage() {
  return (
    <div data-testid="css-test-page">
      <CssTestNav />
      <PanelA />
    </div>
  );
}

export function CssTestPanelBPage() {
  return (
    <div data-testid="css-test-page">
      <CssTestNav />
      <PanelB />
    </div>
  );
}

export function CssTestPanelCPage() {
  return (
    <div data-testid="css-test-page">
      <CssTestNav />
      <PanelC />
    </div>
  );
}

export function CssTestPanelDPage() {
  return (
    <div data-testid="css-test-page">
      <CssTestNav />
      <PanelD />
    </div>
  );
}

export function CssTestAllPage() {
  return (
    <div data-testid="css-test-page">
      <CssTestNav />
      <PanelA />
      <PanelB />
      <PanelC />
      <PanelD />
    </div>
  );
}
