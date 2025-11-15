"use server";

import { ReactNode } from "react";

export const StreamingAction = async (data: FormData) => {
  await new Promise((resolve) => setTimeout(resolve, 3000)); // Simulate processing delay
  return {
    promise: new Promise<ReactNode>((resolve) => {
      setTimeout(() => {
        resolve(
          <>
            <div
              style={{
                background: "#d4edda",
                padding: "1rem",
                borderRadius: "4px",
              }}
            >
              <h4 style={{ margin: "0 0 0.5rem 0" }}>✅ Completed!</h4>
            </div>
          </>
        );
      }, 3000); // Simulate delay
    }),
  }; // Simulate delay
};
