export const Logo = () => (
  <span className="flex items-center gap-2 text-[15px]">
    <svg
      aria-hidden="true"
      className="size-4 text-gray-1000"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.75"
      viewBox="0 0 16 16"
    >
      <circle cx="3.5" cy="8" r="1.75" />
      <circle cx="12.5" cy="3.5" r="1.75" />
      <circle cx="12.5" cy="12.5" r="1.75" />
      <path d="M5.25 8h2.5l3.25-4.5M7.75 8l3.25 4.5" />
    </svg>
    <span className="font-semibold text-gray-1000">Rango</span>
  </span>
);
