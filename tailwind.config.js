/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['class'],
  content: [
    './pages/**/*.{js,jsx,ts,tsx,mdx}',
    './components/**/*.{js,jsx,ts,tsx,mdx}',
    './app/**/*.{js,jsx,ts,tsx,mdx}',
    './lib/**/*.{js,jsx,ts,tsx,mdx}',
    './hooks/**/*.{js,jsx,ts,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        surface: {
          700: 'var(--surface-700)',
          800: 'var(--surface-800)',
          900: 'var(--surface-900)',
          950: 'var(--surface-950)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          dim:     'var(--accent-dim)',
          subtle:  'var(--accent-subtle)',
          border:  'var(--accent-border)',
        },
        data: {
          positive: 'var(--data-positive)',
          negative: 'var(--data-negative)',
          flag:     'var(--data-flag)',
          neutral:  'var(--data-neutral)',
        },
        text: {
          primary:   'var(--text-primary)',
          secondary: 'var(--text-secondary)',
          muted:     'var(--text-muted)',
          label:     'var(--text-label)',
        },
        border: {
          DEFAULT: 'var(--border)',
          subtle:  'var(--border-subtle)',
        },
      },
      fontFamily: {
        display: ['var(--font-display)', 'system-ui'],
        body:    ['var(--font-body)', 'system-ui'],
        mono:    ['var(--font-mono)', 'monospace'],
      },
      fontSize: {
        'data-xl': ['1.5rem',    { lineHeight: '1.2', letterSpacing: '-0.02em' }],
        'data-lg': ['1.125rem',  { lineHeight: '1.3', letterSpacing: '-0.01em' }],
        'data-sm': ['0.75rem',   { lineHeight: '1.4', letterSpacing: '0.02em'  }],
        'label':   ['0.6875rem', { lineHeight: '1.4', letterSpacing: '0.08em'  }],
      },
      borderRadius: {
        'panel': '2px',
        'card':  '4px',
        'chip':  '2px',
      },
      animation: {
        'pulse-slow': 'pulse 3s ease-in-out infinite',
        'scan':       'scan 2s ease-in-out infinite',
        'fade-in':    'fadeIn 0.4s ease-out',
        'slide-up':   'slideUp 0.3s ease-out',
        'blink':      'blink 1.2s step-end infinite',
      },
      keyframes: {
        scan:    { '0%, 100%': { opacity: '0.4' }, '50%': { opacity: '1' } },
        fadeIn:  { from: { opacity: '0' }, to: { opacity: '1' } },
        slideUp: { from: { opacity: '0', transform: 'translateY(8px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        blink:   { '0%, 100%': { opacity: '1' }, '50%': { opacity: '0' } },
      },
      maxWidth: {
        'intake':  '640px',
        'confirm': '800px',
        'results': '1100px',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
}
