import React from "react";
import { modules } from "virtual:rsc-router"; // ensure RSC Router is initialized
export default async function HomePage() {
  console.log("[HomePage] Rendering");
  const Comp = (await modules.test()).MyTestPage;
  const Client = (await modules.test2()).Client;
  return (
    <div>
      <h1>Welcome to RSC Router</h1>
      <p>This is the home page with nested layouts and partial rendering!</p>
      <div style={{ marginTop: "2rem" }}>
        <h2>Features:</h2>
        <Client />
        {/* <Comp /> */}
        <ul>
          <li>Express/Hono-style routing</li>
          <li>Nested layouts with Outlet pattern</li>
          <li>Partial rendering on navigation</li>
          <li>Layout state preservation</li>
          <li>Middleware support</li>
        </ul>
      </div>
    </div>
  );
}
