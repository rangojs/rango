"use client";

import { ActionStatus } from "@/components/StreamingActionForm";
import { addToCartWithResult } from "../../actions/shop.actions";

export const AddToCartStatus = () => {
  return <ActionStatus fn={addToCartWithResult} />;
};
