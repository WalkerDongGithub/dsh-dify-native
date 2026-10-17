"""Pure functions from Dify 5dff246, schedule_service.py / schedule_utils.py.
See docs/event-deployment.md for exact functions and version boundary.
"""
from __future__ import annotations
ScheduleConfigError = ValueError

def convert_12h_to_24h(time_str: str) -> tuple[int, int]:
    """
    Parse 12-hour time format to 24-hour format for cron compatibility.

    Args:
        time_str: Time string in format "HH:MM AM/PM" (e.g., "12:30 PM")

    Returns:
        Tuple of (hour, minute) in 24-hour format

    Raises:
        ValueError: If time string format is invalid or values are out of range

    Examples:
        - "12:00 AM" -> (0, 0)    # Midnight
        - "12:00 PM" -> (12, 0)   # Noon
        - "1:30 PM"  -> (13, 30)
        - "11:59 PM" -> (23, 59)
    """
    if not time_str or not time_str.strip():
        raise ValueError("Time string cannot be empty")

    parts = time_str.strip().split()
    if len(parts) != 2:
        raise ValueError(f"Invalid time format: '{time_str}'. Expected 'HH:MM AM/PM'")

    time_part, period = parts
    period = period.upper()

    if period not in ["AM", "PM"]:
        raise ValueError(f"Invalid period: '{period}'. Must be 'AM' or 'PM'")

    time_parts = time_part.split(":")
    if len(time_parts) != 2:
        raise ValueError(f"Invalid time format: '{time_part}'. Expected 'HH:MM'")

    try:
        hour = int(time_parts[0])
        minute = int(time_parts[1])
    except ValueError as e:
        raise ValueError(f"Invalid time values: {e}")

    if hour < 1 or hour > 12:
        raise ValueError(f"Invalid hour: {hour}. Must be between 1 and 12")

    if minute < 0 or minute > 59:
        raise ValueError(f"Invalid minute: {minute}. Must be between 0 and 59")

    # Handle 12-hour to 24-hour edge cases
    if period == "PM" and hour != 12:
        hour += 12
    elif period == "AM" and hour == 12:
        hour = 0

    return hour, minute

def visual_to_cron(frequency: str, visual_config: VisualConfig) -> str:
    """
    Converts user-friendly visual schedule settings to cron expression.
    Maintains consistency with frontend UI expectations while supporting croniter's extended syntax.
    """
    if frequency == "hourly":
        if visual_config.on_minute is None:
            raise ScheduleConfigError("on_minute is required for hourly schedules")
        return f"{visual_config.on_minute} * * * *"

    elif frequency == "daily":
        if not visual_config.time:
            raise ScheduleConfigError("time is required for daily schedules")
        hour, minute = convert_12h_to_24h(visual_config.time)
        return f"{minute} {hour} * * *"

    elif frequency == "weekly":
        if not visual_config.time:
            raise ScheduleConfigError("time is required for weekly schedules")
        if not visual_config.weekdays:
            raise ScheduleConfigError("Weekdays are required for weekly schedules")
        hour, minute = convert_12h_to_24h(visual_config.time)
        weekday_map = {"sun": "0", "mon": "1", "tue": "2", "wed": "3", "thu": "4", "fri": "5", "sat": "6"}
        cron_weekdays = [weekday_map[day] for day in visual_config.weekdays]
        return f"{minute} {hour} * * {','.join(sorted(cron_weekdays))}"

    elif frequency == "monthly":
        if not visual_config.time:
            raise ScheduleConfigError("time is required for monthly schedules")
        if not visual_config.monthly_days:
            raise ScheduleConfigError("Monthly days are required for monthly schedules")
        hour, minute = convert_12h_to_24h(visual_config.time)

        numeric_days: list[int] = []
        has_last = False
        for day in visual_config.monthly_days:
            if day == "last":
                has_last = True
            else:
                numeric_days.append(day)

        result_days = [str(d) for d in sorted(set(numeric_days))]
        if has_last:
            result_days.append("L")

        return f"{minute} {hour} {','.join(result_days)} * *"

    else:
        raise ScheduleConfigError(f"Unsupported frequency: {frequency}")
