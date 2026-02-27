const plans = [
  {
    name: "Free",
    price: "$0",
    period: "forever",
    description: "For individuals and small open-source projects",
    features: [
      "50 reviews / month",
      "3 repositories",
      "Community support",
      "Basic slash commands",
    ],
    current: true,
    cta: "Current Plan",
  },
  {
    name: "Pro",
    price: "$29",
    period: "per month",
    description: "For growing teams that need more power",
    features: [
      "Unlimited reviews",
      "25 repositories",
      "Priority support",
      "All slash commands",
      "Custom review rules",
      "Team management",
    ],
    current: false,
    cta: "Upgrade to Pro",
    popular: true,
  },
  {
    name: "Enterprise",
    price: "$99",
    period: "per month",
    description: "For organizations with advanced needs",
    features: [
      "Unlimited everything",
      "Unlimited repositories",
      "Dedicated support",
      "SSO / SAML",
      "Audit logs",
      "Custom integrations",
      "SLA guarantee",
    ],
    current: false,
    cta: "Contact Sales",
  },
];

export default function BillingPage() {
  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Billing</h1>
        <p className="mt-1 text-gray-400">Manage your subscription and billing information.</p>
      </div>

      {/* Current Plan Banner */}
      <div className="rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-6 flex items-center justify-between">
        <div>
          <p className="text-sm text-gray-400">Current Plan</p>
          <p className="text-xl font-bold text-indigo-300 mt-1">Free Tier</p>
          <p className="text-sm text-gray-400 mt-1">32 of 50 reviews used this month</p>
        </div>
        <div className="text-right">
          <p className="text-sm text-gray-400">Billing cycle resets</p>
          <p className="text-sm font-medium text-gray-200">March 1, 2025</p>
        </div>
      </div>

      {/* Usage Bar */}
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-6">
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-medium text-gray-300">Monthly Review Usage</p>
          <p className="text-sm text-gray-400">32 / 50</p>
        </div>
        <div className="h-2 rounded-full bg-gray-800 overflow-hidden">
          <div className="h-full rounded-full bg-indigo-500" style={{ width: "64%" }} />
        </div>
      </div>

      {/* Pricing Cards */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {plans.map((plan) => (
          <div
            key={plan.name}
            className={`relative rounded-xl border p-6 ${
              plan.popular
                ? "border-indigo-500/50 bg-gray-900 ring-1 ring-indigo-500/20"
                : plan.current
                  ? "border-gray-700 bg-gray-900"
                  : "border-gray-800 bg-gray-900"
            }`}
          >
            {plan.popular && (
              <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-indigo-600 px-3 py-0.5 text-xs font-medium">
                Most Popular
              </span>
            )}
            <div className="mb-6">
              <h3 className="text-lg font-semibold">{plan.name}</h3>
              <div className="mt-2 flex items-baseline gap-1">
                <span className="text-3xl font-bold">{plan.price}</span>
                <span className="text-sm text-gray-400">/ {plan.period}</span>
              </div>
              <p className="mt-2 text-sm text-gray-400">{plan.description}</p>
            </div>

            <ul className="space-y-3 mb-8">
              {plan.features.map((feature) => (
                <li key={feature} className="flex items-center gap-2 text-sm text-gray-300">
                  <svg className="w-4 h-4 text-indigo-400 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                  </svg>
                  {feature}
                </li>
              ))}
            </ul>

            <button
              disabled={plan.current}
              className={`w-full rounded-lg px-4 py-2.5 text-sm font-medium transition-colors ${
                plan.current
                  ? "border border-gray-700 bg-gray-800 text-gray-500 cursor-not-allowed"
                  : plan.popular
                    ? "bg-indigo-600 text-white hover:bg-indigo-500"
                    : "border border-gray-700 bg-gray-800 text-gray-300 hover:bg-gray-750 hover:border-gray-600"
              }`}
            >
              {plan.cta}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
