import 'dart:math' as math;
import 'package:flutter/material.dart';

import '../../../ui/colors.dart';
import '../models/permission_entity.dart';

class PermissionTimeRing extends StatelessWidget {
  final PermissionEntity entity;
  final double size;

  const PermissionTimeRing({
    super.key,
    required this.entity,
    this.size = 44,
  });

  Color get _color {
    switch (entity.trustState) {
      case PermissionTrustState.trustedActive:
        return SFColors.success;
      case PermissionTrustState.limitedActive:
        return SFColors.warning;
      case PermissionTrustState.timeBound:
        return SFColors.primaryBlue;
      case PermissionTrustState.expiringSoon:
        return const Color(0xFFEA7A12);
      case PermissionTrustState.revoked:
        return SFColors.error;
      case PermissionTrustState.flagged:
        return const Color(0xFF111827);
      case PermissionTrustState.unknown:
        return SFColors.textMuted;
    }
  }

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: size,
      width: size,
      child: CustomPaint(
        painter: _RingPainter(
          percent: entity.timeRemainingPercent.clamp(0.0, 1.0),
          color: _color,
          faded: entity.trustState == PermissionTrustState.revoked,
        ),
        child: Center(
          child: Container(
            height: size - 12,
            width: size - 12,
            decoration: BoxDecoration(
              color: _color.withOpacity(0.10),
              shape: BoxShape.circle,
            ),
            child: Icon(entity.icon, color: _color, size: size * 0.42),
          ),
        ),
      ),
    );
  }
}

class _RingPainter extends CustomPainter {
  final double percent;
  final Color color;
  final bool faded;

  _RingPainter({
    required this.percent,
    required this.color,
    required this.faded,
  });

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    final radius = math.min(size.width, size.height) / 2 - 2;
    final background = Paint()
      ..color = SFColors.cardBorder
      ..style = PaintingStyle.stroke
      ..strokeWidth = 3
      ..strokeCap = StrokeCap.round;

    final active = Paint()
      ..color = faded ? color.withOpacity(0.35) : color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 3
      ..strokeCap = StrokeCap.round;

    canvas.drawCircle(center, radius, background);
    if (percent > 0) {
      canvas.drawArc(
        Rect.fromCircle(center: center, radius: radius),
        -math.pi / 2,
        math.pi * 2 * percent,
        false,
        active,
      );
    }
  }

  @override
  bool shouldRepaint(covariant _RingPainter oldDelegate) {
    return oldDelegate.percent != percent ||
        oldDelegate.color != color ||
        oldDelegate.faded != faded;
  }
}
