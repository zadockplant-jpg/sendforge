import 'package:flutter/material.dart';
import '../colors.dart';
import '../theme/sf_theme.dart';
import '../screens/home_screen.dart';

class SFTabBar extends StatelessWidget {
  final HomeTab current;
  final ValueChanged<HomeTab> onChanged;

  const SFTabBar({
    super.key,
    required this.current,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      color: SFColors.headerBlueDark,
      padding: const EdgeInsets.all(12),
      child: Container(
        padding: const EdgeInsets.all(4),
        decoration: BoxDecoration(
          color: Colors.white.withOpacity(0.15),
          borderRadius: BorderRadius.circular(SFTheme.radiusLg),
        ),
        child: Row(
          children: HomeTab.values.map((tab) {
            final selected = tab == current;
            return Expanded(
              child: GestureDetector(
                onTap: () => onChanged(tab),
                child: Container(
                  padding: const EdgeInsets.symmetric(vertical: 10),
                  decoration: BoxDecoration(
                    color: selected ? Colors.white : Colors.transparent,
                    borderRadius: BorderRadius.circular(SFTheme.radiusMd),
                  ),
                  child: Center(
                    child: Text(
                      _label(tab),
                      style: TextStyle(
                        fontWeight: FontWeight.w600,
                        color: selected
                            ? SFColors.textPrimary
                            : Colors.white,
                      ),
                    ),
                  ),
                ),
              ),
            );
          }).toList(),
        ),
      ),
    );
  }

  String _label(HomeTab tab) {
    switch (tab) {
      case HomeTab.threads:
        return 'Threads';
      case HomeTab.groups:
        return 'Groups';
      case HomeTab.blast:
      default:
        return 'Create Blast';
    }
  }
}
