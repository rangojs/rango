import type { CSSProperties, ImgHTMLAttributes } from "react";

/** Local/static image component (docs images are served as-is, no optimizer). */
export interface StaticImageData {
  src: string;
  height: number;
  width: number;
  blurDataURL?: string;
}

export interface ImageProps extends Omit<
  ImgHTMLAttributes<HTMLImageElement>,
  "src" | "width" | "height" | "loading"
> {
  src: string | StaticImageData;
  alt: string;
  width?: number | string;
  height?: number | string;
  fill?: boolean;
  sizes?: string;
  priority?: boolean;
  loading?: "eager" | "lazy";
  quality?: number;
  unoptimized?: boolean;
  placeholder?: "blur" | "empty" | (string & {});
  blurDataURL?: string;
}

export default function Image({
  src,
  alt,
  width,
  height,
  fill,
  sizes,
  priority,
  loading,
  quality: _quality,
  unoptimized: _unoptimized,
  placeholder: _placeholder,
  blurDataURL: _blurDataURL,
  style,
  ...rest
}: ImageProps) {
  const srcUrl = typeof src === "string" ? src : src.src;
  const resolvedStyle: CSSProperties | undefined = fill
    ? {
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        ...style,
      }
    : style;

  return (
    <img
      alt={alt}
      decoding="async"
      fetchPriority={priority ? "high" : undefined}
      loading={priority ? "eager" : (loading ?? "lazy")}
      sizes={sizes}
      src={srcUrl}
      style={resolvedStyle}
      {...(fill ? {} : { height, width })}
      {...rest}
    />
  );
}
