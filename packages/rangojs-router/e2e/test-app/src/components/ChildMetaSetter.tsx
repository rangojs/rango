import type { MetaDescriptor } from "@rangojs/router/server";

interface ChildMetaSetterProps {
  meta: (descriptor: MetaDescriptor) => void;
  title: string;
  description: string;
}

/**
 * RSC component that receives meta push function as prop and calls it.
 * Tests the pattern of passing handle functions to child components.
 */
export function ChildMetaSetter({ meta, title, description }: ChildMetaSetterProps) {
  // Call meta from child RSC component
  meta({ title });
  meta({ name: "description", content: description });
  meta({ property: "og:title", content: title });

  return (
    <div data-testid="child-meta-setter">
      <p data-testid="child-set-title">Set title: {title}</p>
      <p data-testid="child-set-description">Set description: {description}</p>
    </div>
  );
}
