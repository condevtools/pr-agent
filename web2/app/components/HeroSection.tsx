import Link from 'next/link'
import ShaderGradientBg from './ShaderGradientBg'

export default function HeroSection() {
  return (

    <section className="relative min-h-screen flex flex-col items-center justify-center pt-16 overflow-hidden bg-black">
      {/* ShaderGradient background */}
      <div className="absolute inset-0 pointer-events-none">
        <ShaderGradientBg />
      </div>
      {/* Bottom fade to black */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />
      </div>

      <div className="relative z-10 max-w-[1440px] mx-auto px-6 lg:px-10 text-center w-full">
        {/* Top badge */}
        <div className="inline-flex items-center gap-2.5 px-4 py-2 border border-white/15 rounded-full mb-8">
          <span className="w-1.5 h-1.5 rounded-full bg-white" />
          <span className="text-white/70 text-sm">No. 1 Studio of 2025</span>
        </div>

        {/* Main heading */}
        <h1 className="text-5xl sm:text-6xl md:text-7xl lg:text-[84px] font-bold text-white leading-[1.05] tracking-tight mb-6 max-w-5xl mx-auto">
          Premium Agency
          <br />
          for Creatives.
        </h1>

        {/* Subtitle */}
        <p className="text-white/55 text-lg max-w-[540px] mx-auto mb-10 leading-relaxed">
          We specialize in crafting unique digital presence that help businesses grow and stand out
          in their industries.
        </p>

        {/* CTA buttons */}
        <div className="flex flex-wrap items-center justify-center gap-4 mb-16">
          <Link
            href="/contact"
            className="px-8 py-4 bg-[#0055fe] text-white font-medium text-sm hover:bg-[#0044cc] transition-colors"
          >
            Connect With Us
          </Link>
          <Link
            href="/about"
            className="px-8 py-4 border border-white/25 text-white/80 text-sm hover:border-white/50 hover:text-white transition-colors"
          >
            What is Landin?
          </Link>
        </div>

        {/* Social proof pill */}
        <div className="inline-flex items-center gap-3 px-5 py-2.5 bg-white/5 border border-white/10 rounded-full">
          <div className="flex -space-x-2">
            {[...Array(5)].map((_, i) => (
              <div
                key={i}
                className="w-7 h-7 rounded-full border-2 border-black bg-gradient-to-br from-white/40 to-white/20"
                style={{ zIndex: 5 - i }}
              />
            ))}
          </div>
          <span className="text-white/60 text-sm">200+ Agencies Rated</span>
        </div>
      </div>

      {/* Bottom fade */}
      <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-black to-transparent pointer-events-none" />
    </section>
  )
}
