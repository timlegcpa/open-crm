/** @type {import('tailwindcss').Config} */
module.exports = {
    darkMode: ["class"],
    content: ["./index.html", "./src/**/*.{ts,tsx,js,jsx}"],
  theme: {
  	extend: {
  		fontFamily: {
  			// One definition: --font-sans in src/index.css (Inter, then the system stack).
  			sans: ['var(--font-sans)'],
  		},
  		borderRadius: {
  			lg: 'var(--radius)',
  			md: 'calc(var(--radius) - 2px)',
  			sm: 'calc(var(--radius) - 4px)'
  		},
  		colors: {
  			background: 'hsl(var(--background))',
  			foreground: 'hsl(var(--foreground))',
  			card: {
  				DEFAULT: 'hsl(var(--card))',
  				foreground: 'hsl(var(--card-foreground))'
  			},
  			popover: {
  				DEFAULT: 'hsl(var(--popover))',
  				foreground: 'hsl(var(--popover-foreground))'
  			},
  			primary: {
  				DEFAULT: 'hsl(var(--primary))',
  				foreground: 'hsl(var(--primary-foreground))'
  			},
  			secondary: {
  				DEFAULT: 'hsl(var(--secondary))',
  				foreground: 'hsl(var(--secondary-foreground))'
  			},
  			muted: {
  				DEFAULT: 'hsl(var(--muted))',
  				foreground: 'hsl(var(--muted-foreground))'
  			},
  			accent: {
  				DEFAULT: 'hsl(var(--accent))',
  				foreground: 'hsl(var(--accent-foreground))'
  			},
  			destructive: {
  				DEFAULT: 'hsl(var(--destructive))',
  				foreground: 'hsl(var(--destructive-foreground))',
  				light: 'hsl(var(--destructive-light))',
  				dark: 'hsl(var(--destructive-dark))'
  			},
  			success: {
  				DEFAULT: 'hsl(var(--success))',
  				light: 'hsl(var(--success-light))',
  				dark: 'hsl(var(--success-dark))'
  			},
  			warning: {
  				DEFAULT: 'hsl(var(--warning))',
  				light: 'hsl(var(--warning-light))',
  				dark: 'hsl(var(--warning-dark))'
  			},
  			// Status-only colours beyond the green/amber/red trio: the tone pairs ToneBadge
  			// and the board stages draw (deep text on a pale fill, both themes).
  			caution: {
  				DEFAULT: 'hsl(var(--caution))',
  				light: 'hsl(var(--caution-light))',
  				dark: 'hsl(var(--caution-dark))'
  			},
  			attention: {
  				DEFAULT: 'hsl(var(--attention))',
  				light: 'hsl(var(--attention-light))',
  				dark: 'hsl(var(--attention-dark))'
  			},
  			review: {
  				DEFAULT: 'hsl(var(--review))',
  				light: 'hsl(var(--review-light))',
  				dark: 'hsl(var(--review-dark))'
  			},
  			link: 'hsl(var(--link))',
  			lane: {
  				DEFAULT: 'hsl(var(--lane))',
  				card: 'hsl(var(--lane-card))'
  			},
  			border: 'hsl(var(--border))',
  			input: 'hsl(var(--input))',
  			ring: 'hsl(var(--ring))',
  			chart: {
  				'1': 'hsl(var(--chart-1))',
  				'2': 'hsl(var(--chart-2))',
  				'3': 'hsl(var(--chart-3))',
  				'4': 'hsl(var(--chart-4))',
  				'5': 'hsl(var(--chart-5))'
  			},
  			sidebar: {
  				DEFAULT: 'hsl(var(--sidebar-background))',
  				foreground: 'hsl(var(--sidebar-foreground))',
  				primary: 'hsl(var(--sidebar-primary))',
  				'primary-foreground': 'hsl(var(--sidebar-primary-foreground))',
  				accent: 'hsl(var(--sidebar-accent))',
  				'accent-foreground': 'hsl(var(--sidebar-accent-foreground))',
  				border: 'hsl(var(--sidebar-border))',
  				ring: 'hsl(var(--sidebar-ring))'
  			}
  		},
  		keyframes: {
  			'accordion-down': {
  				from: { height: '0' },
  				to: { height: 'var(--radix-accordion-content-height)' }
  			},
  			'accordion-up': {
  				from: { height: 'var(--radix-accordion-content-height)' },
  				to: { height: '0' }
  			},
  			// The fake caret in InputOTP's active slot.
  			'caret-blink': {
  				'0%,70%,100%': { opacity: '1' },
  				'20%,50%': { opacity: '0' }
  			}
  		},
  		animation: {
  			'accordion-down': 'accordion-down 0.2s ease-out',
  			'accordion-up': 'accordion-up 0.2s ease-out',
  			'caret-blink': 'caret-blink 1.25s ease-out infinite'
  		}
  	}
  },
  plugins: [require("tailwindcss-animate")],
}
