# Birthday Tracker Feature

A Discord bot feature that allows users to set, update, and manage their birthdays within a server.

## Overview

The Birthday Tracker feature allows users to:

-   Set their birthday using a simple slash command
-   Update their existing birthday information
-   Delete their birthday from the server
-   Optionally include their birth year for age display
-   Store birthdays per server (guild-specific)

## Usage

### Setting a Birthday

Users can use the `/birthday` command to open a modal where they can:

1. Enter their birth month (1-12)
2. Enter their birth day (1-31)
3. Optionally enter their birth year for age calculation
4. Choose to save or delete their birthday

### Modal Fields

-   **Month**: Number from 1-12 (January-December)
-   **Day**: Number from 1-31 (validated against month)
-   **Year**: Optional 4-digit year (1900-current year)
-   **Action**: "save" to save the birthday or "delete" to remove it

## Technical Implementation

### Database Schema

The feature uses a `birthdays` table with the following structure:

-   `id`: Primary key
-   `guild_id`: Discord guild/server ID
-   `user_id`: Discord user ID
-   `month`: Birth month (1-12)
-   `day`: Birth day (1-31)
-   `year`: Birth year (nullable for privacy)
-   `display_name`: User's display name when birthday was set
-   `username`: User's username when birthday was set
-   `created_at`: Timestamp when birthday was first set
-   `updated_at`: Timestamp when birthday was last updated
-   `config_version`: For schema migrations

### Components

1. **Command**: `/birthday` - Opens the birthday management modal
2. **Modal**: Interactive form for setting/updating/deleting birthdays
3. **Repository**: Database operations for birthday management
4. **Schema**: TypeScript types and database table definition

### Features

-   **Validation**: Ensures valid dates (e.g., no February 30th)
-   **Privacy**: Year is optional to protect user privacy
-   **Guild-specific**: Each server has its own birthday list
-   **Update/Delete**: Users can modify or remove their birthday
-   **Ephemeral responses**: All interactions are private to the user

### Future Enhancements

Potential future features could include:

-   Birthday notifications/announcements
-   Birthday list viewing for server admins
-   Upcoming birthdays display
-   Birthday reminders
-   Custom birthday messages

## File Structure

```
birthday-tracker/
├── commands/
│   └── birthdayCommand.ts      # /birthday slash command
├── components/
│   ├── index.ts                # Component exports
│   └── birthdayModal.ts        # Modal component and handler
├── data/
│   ├── birthdayRepo.ts         # Database operations
│   └── birthdaySchema.ts       # TypeScript types and schema
├── birthdayModalHandler.ts     # Modal handler registration
└── index.ts                    # Feature exports
```

## Integration

The feature is integrated into the main bot through:

1. Database schema addition in `database.ts`
2. Migration file for table creation
3. Command and modal registration in `bot.ts`

```

```
