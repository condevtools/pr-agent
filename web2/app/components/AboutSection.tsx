import Link from 'next/link'

export default function AboutSection() {
  return (
    <section className="bg-black py-24 lg:py-32">
      <div className="max-w-[1440px] mx-auto px-6 lg:px-10">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-16 items-center">
          {/* Left: Image card */}
          <div className="relative">
            <div className="relative bg-[#080808] border border-white/8 aspect-[528/534] max-w-[528px] mx-auto lg:mx-0 flex flex-col justify-between p-10">
              {/* Inner border effect */}
              <div className="absolute inset-[10px] border border-white/5" />

              {/* Content inside card */}
              <div className="relative z-10">
                <div className="w-12 h-12 rounded-full bg-[#0055fe]/20 flex items-center justify-center mb-6">
                  <div className="w-5 h-5 rounded-full bg-[#0055fe]" />
                </div>
                <p className="text-white/40 text-sm leading-relaxed max-w-[280px]">
                  Elevate your brand effortlessly. Premium design solutions tailored for creatives
                  who want to stand out.
                </p>
              </div>

              {/* Bottom CTA on card */}
              <div className="relative z-10">
                <Link
                  href="/contact"
                  className="inline-flex items-center gap-3 px-6 py-3 bg-[#0055fe] text-white text-sm font-medium hover:bg-[#0044cc] transition-colors"
                >
                  Book a 15-min call
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
                  </svg>
                </Link>
              </div>

              {/* Bottom divider */}
              <div className="absolute bottom-0 left-10 right-10 h-px bg-white/5" />
            </div>
          </div>

          {/* Right: Text content */}
          <div className="flex flex-col gap-6">
            {/* Section label */}
            <div className="inline-flex items-center gap-2 w-fit">
              <span className="w-1.5 h-1.5 rounded-full bg-white/60" />
              <span className="text-white/50 text-sm">About Landin</span>
            </div>

            {/* Heading */}
            <div>
              <h2 className="text-4xl md:text-5xl font-bold text-white leading-tight mb-1">
                Building Stronger Brands
              </h2>
              <h2 className="text-4xl md:text-5xl font-bold text-white leading-tight">
                Creating Impressions!
              </h2>
            </div>

            {/* Description */}
            <p className="text-white/55 text-base leading-relaxed max-w-[480px]">
              Delivering high-quality, on-demand designs with precision. Elevate your brand
              effortlessly, one snap at a time.
            </p>

            {/* Stats list */}
            <div className="flex flex-col gap-3 mt-2">
              {[
                'From $0 to $500,000 in revenue.',
                '47% growth in new customers.',
              ].map((stat) => (
                <div key={stat} className="flex items-center gap-3">
                  <div className="flex-shrink-0 w-5 h-5 rounded-full bg-[#0055fe]/20 flex items-center justify-center">
                    <svg className="w-3 h-3 text-[#0055fe]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  <span className="text-white/80 text-sm">{stat}</span>
                </div>
              ))}
            </div>

            {/* CTA */}
            <div className="mt-4">
              <Link
                href="/about"
                className="inline-flex items-center gap-3 px-6 py-3 bg-[#0055fe] text-white text-sm font-medium hover:bg-[#0044cc] transition-colors"
              >
                View About Landin
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
                </svg>
              </Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
