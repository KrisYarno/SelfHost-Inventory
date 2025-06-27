"use client";

import { useState } from "react";

export default function TestDesignTokens() {
  const [darkMode, setDarkMode] = useState(false);

  return (
    <div className={darkMode ? "dark" : ""}>
      <div className="min-h-screen bg-background text-foreground transition-colors duration-300">
        <div className="container mx-auto p-8">
          <div className="flex justify-between items-center mb-8">
            <h1 className="text-h1">Design Tokens Test Page</h1>
            <button
              onClick={() => setDarkMode(!darkMode)}
              className="button-primary px-4 py-2"
            >
              Toggle {darkMode ? "Light" : "Dark"} Mode
            </button>
          </div>

          {/* Typography */}
          <section className="mb-12">
            <h2 className="text-h2 mb-6">Typography</h2>
            <div className="space-y-4">
              <p className="text-display-lg">Display Large</p>
              <p className="text-display">Display</p>
              <p className="text-h1">Heading 1</p>
              <p className="text-h2">Heading 2</p>
              <p className="text-h3">Heading 3</p>
              <p className="text-h4">Heading 4</p>
              <p className="text-body-lg">Body Large</p>
              <p className="text-body">Body (default)</p>
              <p className="text-body-sm">Body Small</p>
              <p className="text-label">Label Text</p>
              <p className="text-caption">Caption Text</p>
              <p className="text-metric-lg font-mono">Metric Large: 1,234.56</p>
              <p className="text-metric font-mono">Metric: 567.89</p>
              <p className="text-number font-mono">Number: 123</p>
            </div>
          </section>

          {/* Colors */}
          <section className="mb-12">
            <h2 className="text-h2 mb-6">Colors</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="card">
                <div className="h-20 bg-primary rounded-lg mb-2"></div>
                <p className="text-label">Primary</p>
              </div>
              <div className="card">
                <div className="h-20 bg-accent rounded-lg mb-2"></div>
                <p className="text-label">Accent</p>
              </div>
              <div className="card">
                <div className="h-20 bg-success rounded-lg mb-2"></div>
                <p className="text-label">Success</p>
              </div>
              <div className="card">
                <div className="h-20 bg-warning rounded-lg mb-2"></div>
                <p className="text-label">Warning</p>
              </div>
              <div className="card">
                <div className="h-20 bg-error rounded-lg mb-2"></div>
                <p className="text-label">Error</p>
              </div>
              <div className="card">
                <div className="h-20 bg-info rounded-lg mb-2"></div>
                <p className="text-label">Info</p>
              </div>
              <div className="card">
                <div className="h-20 bg-surface rounded-lg mb-2 border"></div>
                <p className="text-label">Surface</p>
              </div>
              <div className="card">
                <div className="h-20 bg-border rounded-lg mb-2"></div>
                <p className="text-label">Border</p>
              </div>
            </div>
          </section>

          {/* Inventory Colors */}
          <section className="mb-12">
            <h2 className="text-h2 mb-6">Inventory-Specific Colors</h2>
            <div className="grid grid-cols-3 gap-4">
              <div className="card">
                <div className="h-20 bg-inventory-increase rounded-lg mb-2"></div>
                <p className="text-label">Inventory Increase</p>
              </div>
              <div className="card">
                <div className="h-20 bg-inventory-decrease rounded-lg mb-2"></div>
                <p className="text-label">Inventory Decrease</p>
              </div>
              <div className="card">
                <div className="h-20 bg-inventory-neutral rounded-lg mb-2"></div>
                <p className="text-label">Inventory Neutral</p>
              </div>
            </div>
          </section>

          {/* Shadows */}
          <section className="mb-12">
            <h2 className="text-h2 mb-6">Shadows</h2>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
              <div className="bg-surface p-4 rounded-lg shadow-sm">
                <p className="text-label">Shadow SM</p>
              </div>
              <div className="bg-surface p-4 rounded-lg shadow">
                <p className="text-label">Shadow Default</p>
              </div>
              <div className="bg-surface p-4 rounded-lg shadow-md">
                <p className="text-label">Shadow MD</p>
              </div>
              <div className="bg-surface p-4 rounded-lg shadow-lg">
                <p className="text-label">Shadow LG</p>
              </div>
              <div className="bg-surface p-4 rounded-lg shadow-xl">
                <p className="text-label">Shadow XL</p>
              </div>
            </div>
          </section>

          {/* Components */}
          <section className="mb-12">
            <h2 className="text-h2 mb-6">Component Examples</h2>
            <div className="space-y-6">
              {/* Card with hover effect */}
              <div className="card card-lift cursor-pointer">
                <h3 className="text-h3 mb-2">Interactive Card</h3>
                <p className="text-body">This card has a lift effect on hover with enhanced shadow.</p>
              </div>

              {/* Input */}
              <div>
                <label className="text-label block mb-2">Input Field</label>
                <input
                  type="text"
                  placeholder="Type something..."
                  className="input w-full px-4 py-2"
                />
              </div>

              {/* Toast examples */}
              <div className="space-y-4">
                <div className="toast toast-success">
                  <p className="font-medium">Success!</p>
                  <p className="text-body-sm">Your changes have been saved.</p>
                  <div className="toast-timer"></div>
                </div>
                <div className="toast toast-error">
                  <p className="font-medium">Error!</p>
                  <p className="text-body-sm">Something went wrong.</p>
                </div>
                <div className="toast toast-warning">
                  <p className="font-medium">Warning!</p>
                  <p className="text-body-sm">Please review your input.</p>
                </div>
                <div className="toast toast-info">
                  <p className="font-medium">Info</p>
                  <p className="text-body-sm">New updates are available.</p>
                </div>
              </div>
            </div>
          </section>

          {/* Background Patterns */}
          <section className="mb-12">
            <h2 className="text-h2 mb-6">Background Patterns</h2>
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-surface rounded-lg p-8 bg-dot-pattern">
                <p className="text-label">Dot Pattern</p>
              </div>
              <div className="bg-surface rounded-lg p-8 bg-grid-pattern">
                <p className="text-label">Grid Pattern</p>
              </div>
            </div>
          </section>

          {/* Spacing */}
          <section className="mb-12">
            <h2 className="text-h2 mb-6">Spacing System (4px base)</h2>
            <div className="space-y-2">
              {[0.5, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24].map((space) => (
                <div key={space} className="flex items-center gap-4">
                  <span className="text-label w-16">{space}</span>
                  <div className={`bg-primary h-4 w-${space}`}></div>
                  <span className="text-caption">{space * 4}px</span>
                </div>
              ))}
            </div>
          </section>

          {/* Border Radius */}
          <section className="mb-12">
            <h2 className="text-h2 mb-6">Border Radius</h2>
            <div className="grid grid-cols-3 md:grid-cols-6 gap-4">
              <div className="bg-surface p-4 rounded-none border text-center">
                <p className="text-label">None</p>
              </div>
              <div className="bg-surface p-4 rounded-sm border text-center">
                <p className="text-label">SM</p>
              </div>
              <div className="bg-surface p-4 rounded-md border text-center">
                <p className="text-label">MD</p>
              </div>
              <div className="bg-surface p-4 rounded-lg border text-center">
                <p className="text-label">LG</p>
              </div>
              <div className="bg-surface p-4 rounded-xl border text-center">
                <p className="text-label">XL</p>
              </div>
              <div className="bg-surface p-4 rounded-2xl border text-center">
                <p className="text-label">2XL</p>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}