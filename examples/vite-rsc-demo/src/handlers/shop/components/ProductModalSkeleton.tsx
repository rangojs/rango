"use client";

const skeletonStyle = {
  background: "linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%)",
  backgroundSize: "200% 100%",
  animation: "shimmer 1.5s infinite",
  borderRadius: "4px",
};

const styles = {
  overlay: {
    position: "fixed" as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: "rgba(0,0,0,0.5)",
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "center",
    paddingTop: "5vh",
    zIndex: 1000,
    overflow: "auto",
  },
  modal: {
    background: "white",
    borderRadius: "8px",
    width: "100%",
    maxWidth: "900px",
    maxHeight: "90vh",
    overflow: "auto",
    boxShadow: "0 25px 50px -12px rgba(0,0,0,0.25)",
    margin: "0 1rem 2rem",
  },
  header: {
    padding: "1.5rem",
    borderBottom: "1px solid #e2e8f0",
    background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
    borderRadius: "8px 8px 0 0",
  },
  body: {
    padding: "1.5rem",
  },
  section: {
    marginBottom: "1.5rem",
  },
  buttonGroup: {
    display: "flex",
    gap: "0.5rem",
    marginTop: "1rem",
  },
};

// Skeleton for product detail modal - self-contained with overlay
// Must include overlay/modal wrapper because loading() may render before layout()
export function ProductModalSkeleton() {
  return (
    <div style={styles.overlay}>
      <div style={styles.modal}>
        <div style={styles.header}>
          <div style={{ ...skeletonStyle, height: "28px", width: "60%", background: "rgba(255,255,255,0.3)" }} />
        </div>
        <div style={styles.body}>
          <div style={styles.section}>
            <div style={{ ...skeletonStyle, height: "12px", width: "60px", marginBottom: "0.5rem" }} />
            <div style={{ ...skeletonStyle, height: "24px", width: "100px" }} />
          </div>
          <div style={styles.section}>
            <div style={{ ...skeletonStyle, height: "12px", width: "40px", marginBottom: "0.5rem" }} />
            <div style={{ ...skeletonStyle, height: "32px", width: "80px" }} />
          </div>
          <div style={styles.section}>
            <div style={{ ...skeletonStyle, height: "12px", width: "80px", marginBottom: "0.5rem" }} />
            <div style={{ ...skeletonStyle, height: "16px", width: "100%", marginBottom: "0.5rem" }} />
            <div style={{ ...skeletonStyle, height: "16px", width: "90%", marginBottom: "0.5rem" }} />
            <div style={{ ...skeletonStyle, height: "16px", width: "70%" }} />
          </div>
          <div style={styles.section}>
            <div style={{ ...skeletonStyle, height: "12px", width: "70px", marginBottom: "0.5rem" }} />
            <div style={{ ...skeletonStyle, height: "16px", width: "120px" }} />
          </div>
          <div style={styles.buttonGroup}>
            <div style={{ ...skeletonStyle, height: "44px", flex: 1 }} />
            <div style={{ ...skeletonStyle, height: "44px", width: "120px" }} />
          </div>
        </div>
      </div>
    </div>
  );
}
