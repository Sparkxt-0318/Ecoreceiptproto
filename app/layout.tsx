export const metadata = {
  title: 'EcoReceipt MVP',
  description: 'Greenwashing-detection prototype.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily:
            'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
          margin: 0,
          padding: 24,
          background: '#fafafa',
          color: '#111',
        }}
      >
        {children}
      </body>
    </html>
  );
}
