import type { Metadata } from "next";
import "./globals.css"; // Keep global styles

// Removed font imports and setup

// Simplified metadata - can be customized later if needed
export const metadata: Metadata = {
  title: "Mineflayer Bot Manager", // Updated title
  description: "Manage Mineflayer bots",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      {/* Removed font className */}
      <body>
        {children}
      </body>
    </html>
  );
}
