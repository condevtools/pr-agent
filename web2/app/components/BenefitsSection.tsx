import Link from 'next/link'

const BENEFIT_TAGS = [
  'Enhanced UX',
  'Boosted Conversions',
  'Fast Loading',
  'SEO Optimized',
  'Customizable',
  'Scalable',
  'Increased Engagement',
  'Expandable',
  'Secure',
  'User-Friendly',
]

const BENEFIT_CARDS = [
  { title: 'Quick Turnaround', badge: 'NEW', desc: 'We prioritize efficiency without compromising quality.' },
  { title: 'Publish in Seconds', badge: null, desc: 'Publish your site in seconds with our streamlined process.' },
  { title: 'Requests & Revisions', badge: 'NEW', desc: 'Multiple rounds of requests and revisions to meet your expectations.' },
  { title: 'Worry Free Pricing', badge: 'NEW', desc: 'Flexible pricing plans designed to fit your needs and budget.' },
]

export default function BenefitsSection() {
  return (
    <section className="bg-black py-24 lg:py-32">
      <div className="max-w-[1440px] mx-auto px-6 lg:px-10">
        {/* Label */}
        <div className="inline-flex items-center gap-2 mb-6">
          <span className="w-1.5 h-1.5 rounded-full bg-white/60" />
          <span className="text-white/50 text-sm">Landin Benefits</span>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-20">
          {/* Left column */}
          <div className="flex flex-col gap-8">
            <div>
              <h2 className="text-4xl md:text-5xl font-bold text-white leading-tight">
                We Just Don&apos;t Design, We Build.
              </h2>
              <h2 className="text-4xl md:text-5xl font-bold text-white/40 leading-tight mt-1">
                If You Can Dream It, We Can Play It!
              </h2>
            </div>

            {/* Tag cloud */}
            <div className="flex flex-wrap gap-2.5">
              {BENEFIT_TAGS.map((tag) => (
                <span
                  key={tag}
                  className="px-4 py-2 border border-white/12 text-white/60 text-sm hover:border-white/25 hover:text-white/80 transition-colors cursor-default"
                >
                  {tag}
                </span>
              ))}
            </div>

            <Link
              href="/contact"
              className="inline-flex items-center gap-2 px-6 py-3 bg-[#0055fe] text-white text-sm font-medium hover:bg-[#0044cc] transition-colors w-fit mt-2"
            >
              Contact Now
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
              </svg>
            </Link>
          </div>

          {/* Right column */}
          <div className="flex flex-col gap-4">
            {/* Main card */}
            <div className="bg-[#080808] border border-white/8 p-8 flex flex-col gap-4">
              <h3 className="text-white font-semibold text-lg">Submit Unlimited Requests</h3>
              <p className="text-white/50 text-sm leading-relaxed">
                Enjoy the freedom to submit unlimited requests without any restrictions. Whether you
                need design tweaks, we&apos;re here to assist you at every step.
              </p>
              <div className="flex gap-3 pt-2">
                <Link
                  href="/contact"
                  className="px-4 py-2 bg-[#0055fe] text-white text-xs font-medium hover:bg-[#0044cc] transition-colors"
                >
                  Book an Appointment
                </Link>
                <Link
                  href="/about"
                  className="px-4 py-2 border border-white/15 text-white/60 text-xs hover:border-white/30 hover:text-white/80 transition-colors"
                >
                  What is Landin?
                </Link>
              </div>
            </div>

            {/* Small cards grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {BENEFIT_CARDS.map((card) => (
                <div key={card.title} className="bg-[#080808] border border-white/8 p-5 flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-white text-sm font-medium">{card.title}</span>
                    {card.badge && (
                      <span className="px-1.5 py-0.5 bg-white/8 text-white/50 text-xs border border-white/10">
                        {card.badge}
                      </span>
                    )}
                  </div>
                  <p className="text-white/45 text-xs leading-relaxed">{card.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
