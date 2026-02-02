"use client";

import { useLocationState } from "@rangojs/router/client";
import { Modal } from "./Modal.js";
import { SlowProductLocationState } from "../location-states.js";

export function SlowModalSkeleton() {
  const locationState = useLocationState(SlowProductLocationState);
  const productName = locationState?.productName;
  const productPrice = locationState?.productPrice;

  return (
    <Modal testId="slow-product-modal">
      <div data-testid="slow-modal-loading">
        <p>Loading product details...</p>
        {productName ? (
          <h2 data-testid="slow-modal-state-name">{productName}</h2>
        ) : (
          <div
            data-testid="slow-modal-skeleton-name"
            style={{ width: "200px", height: "24px", background: "#e0e0e0", marginBottom: "8px" }}
          />
        )}
        {productPrice !== undefined ? (
          <p data-testid="slow-modal-state-price">${productPrice}</p>
        ) : (
          <div
            data-testid="slow-modal-skeleton-price"
            style={{ width: "100px", height: "20px", background: "#e0e0e0", marginBottom: "8px" }}
          />
        )}
        <div
          data-testid="slow-modal-skeleton"
          style={{ width: "250px", height: "16px", background: "#e0e0e0" }}
        />
      </div>
    </Modal>
  );
}
