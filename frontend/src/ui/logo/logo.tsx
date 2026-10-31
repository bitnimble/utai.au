import logoUrl from './utai_logo.svg';

const LOGO_ASPECT = 361 / 900;

export const Logo = ({ width = 360 }: { width?: number }) => (
  <img
    src={logoUrl}
    alt="utai.au"
    width={width}
    height={Math.round(width * LOGO_ASPECT)}
    style={{ display: 'block', margin: '0 auto', maxWidth: '100%', height: 'auto' }}
    draggable={false}
  />
);
