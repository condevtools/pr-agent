import Link from 'next/link'

export default function CTASection() {
  return (
    <>
      {/* CTA */}
      <section className="relative bg-black py-24 lg:py-32 overflow-hidden">
        {/* Background glow */}
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-[600px] h-[300px] bg-[#0055fe]/12 rounded-full blur-[100px]" />
        </div>

        <div className="relative max-w-[1440px] mx-auto px-6 lg:px-10 text-center">
          {/* Label */}
          <div className="inline-flex items-center gap-2 mb-8">
            <span className="w-1.5 h-1.5 rounded-full bg-white/60" />
            <span className="text-white/50 text-sm">Join Us Now</span>
          </div>

          {/* Heading */}
          <h2 className="text-4xl md:text-5xl lg:text-6xl font-bold text-white leading-tight mb-3">
            Each Project we Undertake
          </h2>
          <h2 className="text-4xl md:text-5xl lg:text-6xl font-bold text-white leading-tight mb-8">
            is a Unique Opportunity.
          </h2>

          <p className="text-white/50 text-base leading-relaxed max-w-[420px] mx-auto mb-10">
            Ready to take the next step? Join us now and start transforming your vision into reality
            with expert support.
          </p>

          <Link
            href="/contact"
            className="inline-flex items-center gap-3 px-10 py-4 bg-[#0055fe] text-white font-medium hover:bg-[#0044cc] transition-colors"
          >
            Book an Appointment
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
            </svg>
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-black border-t border-white/8 py-10">
        <div className="max-w-[1440px] mx-auto px-6 lg:px-10 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <span className="text-lg font-bold text-white">Landin</span>
            <span className="text-white/20 hidden sm:block">|</span>
            <span className="text-white/40 text-sm">© 2025 Landin. All rights reserved.</span>
          </div>
          <div className="flex items-center gap-6">
            {['Privacy Policy', 'Terms'].map((link) => (
              <Link
                key={link}
                href={`/${link.toLowerCase().replace(' ', '-')}`}
                className="text-white/40 text-sm hover:text-white/70 transition-colors"
              >
                {link}
              </Link>
            ))}
          </div>
        </div>
      </footer>
    </>
  )
}
