import Link from 'next/link'

const FEATURES = [
  {
    title: 'Boost Your Revenue',
    badge: 'PRO',
    subtitle: 'Increase Profits',
    description:
      'Unlock new revenue streams with data-driven strategies and marketing.',
  },
  {
    title: 'Customizable Assets',
    badge: 'NEW',
    subtitle: 'Editable Designs',
    description:
      'Easily modify and personalize design elements to fit your brand\'s identity.',
  },
  {
    title: 'Bug Less Development',
    badge: 'NEW',
    subtitle: 'Optimized Code',
    description:
      'Our bug-less development ensures that your website runs smooth and fast.',
  },
  {
    title: 'Award-Winning Designs',
    badge: 'NEW',
    subtitle: 'Recognized Design',
    description:
      'Our award-winning designs showcase creativity that set us apart in the industry.',
  },
  {
    title: 'Lightning Fast Delivery',
    badge: 'PRO',
    subtitle: 'Quick Turnaround',
    description:
      'Ensuring your deliverables are ready when you need them, with great quality.',
  },
  {
    title: 'Mobile Friendly',
    badge: 'NEW',
    subtitle: 'Responsive',
    description:
      'Our mobile-friendly design ensures your design looks stunning across all devices.',
  },
]

export default function FeaturesSection() {
  return (
    <section className="bg-black py-24 lg:py-32">
      <div className="max-w-[1440px] mx-auto px-6 lg:px-10">
        {/* Header */}
        <div className="mb-16">
          <div className="inline-flex items-center gap-2 mb-6">
            <span className="w-1.5 h-1.5 rounded-full bg-white/60" />
            <span className="text-white/50 text-sm">Features</span>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-end">
            <div>
              <h2 className="text-4xl md:text-5xl font-bold text-white leading-tight">
                Unlimited Design Features
              </h2>
              <h2 className="text-4xl md:text-5xl font-bold text-white leading-tight">
                Delivered In A Second!
              </h2>
            </div>
            <div className="flex flex-col gap-4 lg:items-end">
              <p className="text-white/50 text-sm leading-relaxed max-w-[380px]">
                Get unlimited design features that give you the freedom to create without
                boundaries.
              </p>
              <Link
                href="/about"
                className="inline-flex items-center gap-2 text-white/60 text-sm hover:text-white transition-colors w-fit"
              >
                View About Landin
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
                </svg>
              </Link>
            </div>
          </div>
        </div>

        {/* Feature grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-px bg-white/8">
          {FEATURES.map((feature) => (
            <Link
              key={feature.title}
              href="/contact"
              className="group bg-black p-8 flex flex-col gap-4 border border-white/8 hover:bg-[#080808] transition-colors"
            >
              <div className="flex items-start justify-between gap-3">
                <h3 className="text-white font-semibold text-base leading-snug">{feature.title}</h3>
                <span
                  className={`flex-shrink-0 px-2 py-0.5 text-xs font-medium border ${
                    feature.badge === 'PRO'
                      ? 'bg-[#0055fe]/15 text-[#0055fe] border-[#0055fe]/30'
                      : 'bg-white/8 text-white/60 border-white/15'
                  }`}
                >
                  {feature.badge}
                </span>
              </div>
              <p className="text-white/45 text-xs font-medium uppercase tracking-wider">
                {feature.subtitle}
              </p>
              <p className="text-white/50 text-sm leading-relaxed mt-auto">{feature.description}</p>
            </Link>
          ))}
        </div>
      </div>
    </section>
  )
}
