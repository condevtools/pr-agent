import Link from 'next/link'

const CLIENTS = [
  {
    name: 'Crimson Studio',
    badge: 'NEW',
    description: 'Achieved a increase in sales within six months through a customized strategy.',
    stats: ['30% Increase in Sales', '40% Boost in Retention'],
  },
  {
    name: 'Raven Company Inc',
    badge: null,
    description: 'Streamlined operations, reducing costs by with our automation solutions.',
    stats: ['25% Conversion Rates', '50% Reduced in CPA'],
  },
  {
    name: 'Gotham Wonder',
    badge: 'FRESH',
    description: 'Boosted customer engagement with a digital presence and targeted campaigns.',
    stats: ['60% Increased Traffic', '35% Growth in Sales'],
  },
  {
    name: 'Sling Interactive Tech',
    badge: null,
    description: 'Expanded market reach, tapping into new demographics with a driven approach.',
    stats: ['20% Market Share', '45% Enhanced Visibility'],
  },
]

const ALL_CLIENTS = [...CLIENTS, ...CLIENTS]

export default function ResultsSection() {
  return (
    <section className="bg-black py-24 lg:py-32 overflow-hidden">
      <div className="max-w-[1440px] mx-auto px-6 lg:px-10 mb-16">
        {/* Section label */}
        <div className="inline-flex items-center gap-2 mb-6">
          <div className="w-6 h-6 rounded-full border border-white/20 flex items-center justify-center">
            <span className="w-1.5 h-1.5 rounded-full bg-white/60" />
          </div>
          <span className="text-white/50 text-sm">200+ Agencies Rated</span>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-end">
          <div>
            <h2 className="text-4xl md:text-5xl font-bold text-white leading-tight">
              Delivering Tangible Results
            </h2>
            <h2 className="text-4xl md:text-5xl font-bold text-white leading-tight">
              That Propel Your Success
            </h2>
          </div>
          <div className="flex flex-col gap-4 lg:items-end">
            <p className="text-white/50 text-sm leading-relaxed max-w-[380px]">
              At the core of everything we do lies a commitment to delivering measurable outcomes
              that drive your success.
            </p>
            <Link
              href="/contact"
              className="inline-flex items-center gap-3 px-6 py-3 bg-[#0055fe] text-white text-sm font-medium hover:bg-[#0044cc] transition-colors w-fit"
            >
              Book a 15-min call
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
              </svg>
            </Link>
          </div>
        </div>
      </div>

      {/* Marquee */}
      <div className="relative">
        <div className="flex animate-marquee gap-6" style={{ width: 'max-content' }}>
          {ALL_CLIENTS.map((client, idx) => (
            <div
              key={idx}
              className="flex-shrink-0 w-80 bg-[#080808] border border-white/8 p-6 flex flex-col gap-4"
            >
              <div className="flex items-center justify-between">
                <h3 className="text-white font-semibold text-base">{client.name}</h3>
                {client.badge && (
                  <span className="px-2 py-0.5 bg-[#0055fe]/15 text-[#0055fe] text-xs font-medium border border-[#0055fe]/30">
                    {client.badge}
                  </span>
                )}
              </div>
              <p className="text-white/45 text-sm leading-relaxed">{client.description}</p>
              <div className="flex flex-col gap-2 pt-2 border-t border-white/8">
                {client.stats.map((stat) => (
                  <div key={stat} className="flex items-center gap-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-[#0055fe]" />
                    <span className="text-white/70 text-sm font-medium">{stat}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Gradient masks */}
        <div className="absolute inset-y-0 left-0 w-32 bg-gradient-to-r from-black to-transparent pointer-events-none" />
        <div className="absolute inset-y-0 right-0 w-32 bg-gradient-to-l from-black to-transparent pointer-events-none" />
      </div>
    </section>
  )
}
