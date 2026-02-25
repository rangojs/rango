import "react";

declare module "react" {
  export const ViewTransition: React.FC<{
    name?: string;
    share?: string;
    enter?: string;
    exit?: string;
    children: React.ReactNode;
  }>;
}
