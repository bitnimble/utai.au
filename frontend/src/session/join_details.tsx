import React from 'react';
import { renderSVG } from 'uqr';
import styles from './join_details.module.css';

export { styles as joinStyles };

export const JoinDetails = ({ joinUrl, code }: { joinUrl: string | undefined; code: string }): React.ReactElement => (
  <>
    {joinUrl != null && (
      <>
        <QrImage text={joinUrl} />
        <a className={styles.url} href={joinUrl} target="_blank" rel="noreferrer" data-testid="session-join-url">
          {joinUrl}
        </a>
      </>
    )}
    <p className={styles.hint}>
      Or open the app on a phone, choose Join, and enter
      <span className={styles.bigCode}>{code}</span>
    </p>
  </>
);

const QrImage = ({ text }: { text: string }): React.ReactElement => {
  const svg = React.useMemo(() => renderSVG(text, { ecc: 'M', border: 2 }), [text]);
  return (
    <div
      className={styles.qr}
      role="img"
      aria-label={`QR code for ${text}`}
      dangerouslySetInnerHTML={{ __html: svg }}
      data-testid="session-join-qr"
    />
  );
};
