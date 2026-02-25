"use server";

import {
  incrementPageViews,
  resetLoaderCallCounts,
  usersStore,
} from "./data.js";

/**
 * Action to increment page views
 * Triggers revalidation of the StatsLoader when called
 */
export async function incrementPageViewsAction() {
  const stats = incrementPageViews();
  return {
    success: true,
    newPageViews: stats.pageViews,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Action to reset loader call counts
 * Useful for demonstrating how loaders are called during revalidation
 */
export async function resetCountersAction() {
  resetLoaderCallCounts();
  return {
    success: true,
    message: "Counters reset",
    timestamp: new Date().toISOString(),
  };
}

/**
 * Action to add a new user
 * Demonstrates action + loader refetch pattern
 */
export async function addUserAction(formData: FormData) {
  const name = formData.get("name") as string;
  const email = formData.get("email") as string;
  const role = (formData.get("role") as "admin" | "user" | "guest") || "user";

  if (!name || !email) {
    return {
      success: false,
      error: "Name and email are required",
    };
  }

  const newUser = {
    id: `user-${Date.now()}`,
    name,
    email,
    role,
    lastLogin: new Date(),
  };

  usersStore.push(newUser);

  return {
    success: true,
    user: newUser,
    timestamp: new Date().toISOString(),
  };
}
