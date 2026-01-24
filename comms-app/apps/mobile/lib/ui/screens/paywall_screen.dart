import 'package:flutter/material.dart';

class PaywallScreen extends StatelessWidget {
  final Map<String, dynamic> gate;

  const PaywallScreen({super.key, required this.gate});

  @override
  Widget build(BuildContext context) {
    final used = gate['used'];
    final limit = gate['limit'];
    final plan = gate['plan'];

    return Scaffold(
      appBar: AppBar(title: const Text("Upgrade")),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          children: [
            Text("Plan limit reached", style: Theme.of(context).textTheme.headlineSmall),
            const SizedBox(height: 8),
            Text("Current plan: $plan\nUsed: $used / $limit"),
            const SizedBox(height: 18),
            _PlanCard(title: "Free", subtitle: "20 msgs/mo", price: "\$0"),
            _PlanCard(title: "Basic", subtitle: "Higher limits", price: "\$29/mo"),
            _PlanCard(title: "Pro", subtitle: "Power user", price: "\$79/mo"),
            _PlanCard(title: "Enterprise", subtitle: "Custom", price: "Contact"),
            const Spacer(),
            ElevatedButton(
              onPressed: () => Navigator.pop(context),
              child: const Text("Back"),
            )
          ],
        ),
      ),
    );
  }
}

class _PlanCard extends StatelessWidget {
  final String title, subtitle, price;
  const _PlanCard({required this.title, required this.subtitle, required this.price});

  @override
  Widget build(BuildContext context) {
    return Card(
      child: ListTile(
        title: Text("$title — $price"),
        subtitle: Text(subtitle),
        trailing: const Icon(Icons.arrow_forward),
      ),
    );
  }
}
