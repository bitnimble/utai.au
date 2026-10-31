export const Logo = ({ size = 56, title }: { size?: number; title?: string }) => (
  <img
    src="/favicon.svg"
    alt={title ?? ''}
    title={title}
    width={size}
    height={size}
    draggable={false}
  />
);
