import Link from 'next/link'

export default function TrustSection() {
  return (
    <section className="relative bg-black py-24 lg:py-32 overflow-hidden">
      {/* Background glow */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[400px] bg-[#0055fe]/8 rounded-full blur-[100px]" />
      </div>

      <div className="relative max-w-[1440px] mx-auto px-6 lg:px-10">
        <div className="border border-white/8 bg-[#080808] p-12 lg:p-16 text-center flex flex-col items-center gap-8">
          {/* Label */}
          <div className="inline-flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-white/60" />
            <span className="text-white/50 text-sm">Launch Your Site</span>
          </div>

          {/* Heading */}
          <div>
            <h2 className="text-4xl md:text-5xl lg:text-6xl font-bold text-white leading-tight">
              The Trusted Rise Partner
            </h2>
            <h2 className="text-4xl md:text-5xl lg:text-6xl font-bold text-white leading-tight">
              For Startups And Agencies
            </h2>
          </div>

          {/* Description */}
          <p className="text-white/50 text-base leading-relaxed max-w-[480px]">
            Get your site live in no time! With professional setup and expert support in an easy
            way.
          </p>

          {/* Stats row */}
          <div className="flex flex-wrap justify-center gap-8 lg:gap-16 pt-4 border-t border-white/8 w-full">
            {[
              { value: '200+', label: 'Agencies Served' },
              { value: '98%', label: 'Client Satisfaction' },
              { value: '5yr', label: 'Industry Experience' },
            ].map((stat) => (
              <div key={stat.label} className="text-center">
                <div className="text-3xl font-bold text-white mb-1">{stat.value}</div>
                <div className="text-white/45 text-sm">{stat.label}</div>
              </div>
            ))}
          </div>

          <Link
            href="/about"
            className="inline-flex items-center gap-2 text-white/60 text-sm hover:text-white transition-colors"
          >
            View About Landin
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
            </svg>
          </Link>
        </div>
      </div>
    </section>
  )
}
