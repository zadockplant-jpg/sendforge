import 'package:flutter/material.dart';
import '../colors.dart';

class SFSegmented extends StatelessWidget {
  final bool leftSelected;
  final String leftLabel;
  final IconData leftIcon;
  final VoidCallback onLeft;

  final String rightLabel;
  final IconData rightIcon;
  final VoidCallback onRight;

  const SFSegmented({
    super.key,
    required this.leftSelected,
    required this.leftLabel,
    required this.leftIcon,
    required this.onLeft,
    required this.rightLabel,
    required this.rightIcon,
    required this.onRight,
  });

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Expanded(child: _chip(selected: leftSelected, icon: leftIcon, label: leftLabel, onTap: onLeft)),
        const SizedBox(width: 10),
        Expanded(child: _chip(selected: !leftSelected, icon: rightIcon, label: rightLabel, onTap: onRight)),
      ],
    );
  }

  Widget _chip({
    required bool selected,
    required IconData icon,
    required String label,
    required VoidCallback onTap,
  }) {
    return InkWell(
      borderRadius: BorderRadius.circular(12),
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(12),
          color: selected ? SFColors.primaryBlue : Colors.white,
          border: Border.all(color: selected ? SFColors.primaryBlue : Colors.black12),
        ),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(icon, color: selected ? Colors.white : SFColors.primaryBlue),
            const SizedBox(width: 8),
            Text(
              label,
              style: TextStyle(
                fontWeight: FontWeight.w800,
                color: selected ? Colors.white : SFColors.textPrimary,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
