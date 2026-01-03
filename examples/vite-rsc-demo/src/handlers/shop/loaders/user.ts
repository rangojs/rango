import { createLoader } from "rsc-router";

export type User = {
  id: string;
  name: string;
  email: string;
  role: "customer";
};

const mockUser: User = {
  id: "user-123",
  name: "John Doe",
  email: "john@example.com",
  role: "customer",
};

/**
 * User Loader - fetches current user data
 *
 * Available throughout the shop to display user info in header, etc.
 */
export const UserLoader = createLoader(async (_ctx) => {
  "use server";
  await new Promise((resolve) => setTimeout(resolve, 50));
  return mockUser;
});
